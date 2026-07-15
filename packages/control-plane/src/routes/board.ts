/**
 * Board routes — the agent's server-side interface to interactive tldraw boards.
 *
 * Create persists a `board` artifact on the session (which broadcasts
 * `artifact_created` to the web client, exactly like every other artifact).
 * Mutate and snapshot forward to the BoardRoom Durable Object keyed by boardId.
 * All three are sandbox-authenticated (the agent's `SANDBOX_AUTH_TOKEN`); the
 * browser reaches the board over a separate authenticated WebSocket (see the
 * board WS handler in index.ts).
 */
import { generateId } from "../auth/crypto";
import { createLogger } from "../logger";
import { BoardInternalPaths, buildBoardInternalUrl } from "../board/contracts";
import { SessionInternalPaths } from "../session/contracts";
import { createSessionRuntimeClient } from "../session/runtime-client";
import type { Env } from "../types";
import { error, json, parsePattern, type RequestContext, type Route } from "./shared";

const logger = createLogger("board-routes");

/** Board title cap — a label, not a document. */
const BOARD_TITLE_MAX_LENGTH = 200;
const DEFAULT_BOARD_TITLE = "Whiteboard";

/**
 * Normalize a client-supplied board title: trim, fall back to a default when
 * empty/whitespace/non-string, and cap the length.
 */
export function normalizeBoardTitle(raw: unknown): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return DEFAULT_BOARD_TITLE;
  return trimmed.length > BOARD_TITLE_MAX_LENGTH
    ? trimmed.slice(0, BOARD_TITLE_MAX_LENGTH)
    : trimmed;
}

async function handleCreateBoard(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required", 400);

  let body: { title?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // Body is optional; a bare create with no title is valid.
  }

  const title = normalizeBoardTitle(body.title);
  const boardId = generateId();
  const artifactId = generateId();

  const response = await createSessionRuntimeClient(env, ctx).fetch(
    sessionId,
    SessionInternalPaths.createBoardArtifact,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artifactId, boardId, title }),
    }
  );

  if (!response.ok) {
    const message = await response.text().catch(() => "Failed to create board");
    logger.warn("board.create_failed", {
      event: "board.create_failed",
      session_id: sessionId,
      board_id: boardId,
      http_status: response.status,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error(message || "Failed to create board", response.status);
  }

  logger.info("board.created", {
    event: "board.created",
    session_id: sessionId,
    board_id: boardId,
    artifact_id: artifactId,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });
  return json({ boardId, artifactId, title }, 201);
}

async function handleMutateBoard(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const boardId = match.groups?.boardId;
  if (!boardId) return error("Board ID required", 400);

  const stub = env.BOARD_ROOM.get(env.BOARD_ROOM.idFromName(boardId));
  const response = await stub.fetch(buildBoardInternalUrl(BoardInternalPaths.mutate), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: request.body,
  });
  logger.info("board.mutate", {
    event: "board.mutate",
    session_id: match.groups?.id,
    board_id: boardId,
    http_status: response.status,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });
  return response;
}

async function handleBoardSnapshot(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const boardId = match.groups?.boardId;
  if (!boardId) return error("Board ID required", 400);

  const stub = env.BOARD_ROOM.get(env.BOARD_ROOM.idFromName(boardId));
  const response = await stub.fetch(buildBoardInternalUrl(BoardInternalPaths.snapshot), {
    method: "GET",
  });
  logger.info("board.snapshot", {
    event: "board.snapshot",
    session_id: match.groups?.id,
    board_id: boardId,
    http_status: response.status,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });
  return response;
}

export const boardRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/sessions/:id/board"),
    handler: handleCreateBoard,
  },
  {
    method: "POST",
    pattern: parsePattern("/sessions/:id/board/:boardId/mutate"),
    handler: handleMutateBoard,
  },
  {
    method: "GET",
    pattern: parsePattern("/sessions/:id/board/:boardId/snapshot"),
    handler: handleBoardSnapshot,
  },
];
