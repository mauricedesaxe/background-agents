/**
 * Open-Inspect Control Plane
 *
 * Cloudflare Workers entry point with Durable Objects for session management.
 */

import { handleRequest } from "./router";
import { createLogger } from "./logger";
import { SessionInternalPaths } from "./session/contracts";
import { createSessionRuntimeClient } from "./session/runtime-client";
import type { Env } from "./types";

const logger = createLogger("worker");

// Re-export Durable Objects for Cloudflare to discover
export { SessionDO } from "./session/durable-object";
export { SchedulerDO } from "./scheduler/durable-object";
export { BoardRoom } from "./board/durable-object";

/**
 * Worker fetch handler.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade for session or board
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader?.toLowerCase() === "websocket") {
      const boardMatch = url.pathname.match(/^\/sessions\/([^/]+)\/board\/([^/]+)\/ws$/);
      if (boardMatch) {
        return handleBoardWebSocket(request, env, url, boardMatch[1], boardMatch[2]);
      }
      return handleWebSocket(request, env, url);
    }

    // Regular API request — logged by the router with requestId and timing
    return handleRequest(request, env, ctx);
  },

  /**
   * Cron trigger handler — wakes the SchedulerDO to process overdue automations.
   */
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (!env.SCHEDULER) {
      logger.debug("SCHEDULER binding not configured, skipping scheduled tick");
      return;
    }

    // Always wake the SchedulerDO — it runs both the recovery sweep
    // (orphaned/timed-out runs) and processes overdue automations.
    const doId = env.SCHEDULER.idFromName("global-scheduler");
    const stub = env.SCHEDULER.get(doId);

    await stub.fetch("http://internal/internal/tick", { method: "POST" });
  },
};

/**
 * Handle a board sync WebSocket. The browser presents its session ws-token in
 * the `?token=` query (a raw WebSocket can't send auth headers). Verification
 * lives in the session DO — that's where the participant table is — so we verify
 * there first and only forward the upgrade to the BoardRoom on success. A failed
 * verify closes the connection; an unreachable session DO returns 5xx rather
 * than falling through to an unauthenticated board socket.
 */
async function handleBoardWebSocket(
  request: Request,
  env: Env,
  url: URL,
  sessionId: string,
  boardId: string
): Promise<Response> {
  const token = url.searchParams.get("token");
  if (!token) {
    return new Response("Authentication required", { status: 401 });
  }

  const ctx = { trace_id: crypto.randomUUID(), request_id: crypto.randomUUID().slice(0, 8) };
  let verifyResponse: Response;
  try {
    verifyResponse = await createSessionRuntimeClient(env, ctx).fetch(
      sessionId,
      SessionInternalPaths.verifyWsToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      }
    );
  } catch (e) {
    logger.error("board.ws.verify_unreachable", {
      event: "board.ws.verify_unreachable",
      session_id: sessionId,
      board_id: boardId,
      error: e instanceof Error ? e : String(e),
    });
    return new Response("Board authentication unavailable", { status: 503 });
  }

  if (!verifyResponse.ok) {
    logger.warn("board.ws.auth_failed", {
      event: "board.ws.auth_failed",
      session_id: sessionId,
      board_id: boardId,
      http_status: verifyResponse.status,
    });
    return new Response("Invalid authentication token", { status: 401 });
  }

  logger.info("board.ws.connect", {
    event: "board.ws.connect",
    session_id: sessionId,
    board_id: boardId,
  });

  const stub = env.BOARD_ROOM.get(env.BOARD_ROOM.idFromName(boardId));
  const response = await stub.fetch(request);
  if (response.webSocket) {
    return new Response(null, {
      status: 101,
      webSocket: response.webSocket,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }
  return response;
}

/**
 * Handle WebSocket connections.
 */
async function handleWebSocket(request: Request, env: Env, url: URL): Promise<Response> {
  // Extract session ID from path: /sessions/:id/ws
  const match = url.pathname.match(/^\/sessions\/([^/]+)\/ws$/);

  if (!match) {
    logger.warn("Invalid WebSocket path", { event: "ws.invalid_path", http_path: url.pathname });
    return new Response("Invalid WebSocket path", { status: 400 });
  }

  const sessionId = match[1];
  logger.info("WebSocket upgrade", {
    event: "ws.connect",
    http_path: url.pathname,
    session_id: sessionId,
  });

  // Get Durable Object and forward WebSocket
  const doId = env.SESSION.idFromName(sessionId);
  const stub = env.SESSION.get(doId);

  // Forward the WebSocket upgrade request to the DO
  const response = await stub.fetch(request);

  // If it's a WebSocket upgrade response, return it directly
  // Add CORS headers for the upgrade response
  if (response.webSocket) {
    return new Response(null, {
      status: 101,
      webSocket: response.webSocket,
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  return response;
}
