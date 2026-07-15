/**
 * BoardRoom Durable Object — hosts one tldraw sync room per board id.
 *
 * Browsers connect as WebSocket peers and edit live; the agent mutates the same
 * document server-side over HTTP (`/internal/mutate`) without being a peer, and
 * reads it with `/internal/snapshot`. The room lives here, not in the sandbox,
 * so a board stays editable even while its session's sandbox is asleep, and
 * boards outlive their session's active status. Document state persists
 * automatically to this DO's SQLite via the tldraw `SQLiteSyncStorage` adapter.
 *
 * Modeled on tldraw's official reference (tldraw/tldraw-sync-cloudflare):
 * hibernation WebSockets, one lazily-created room, per-session snapshot
 * attachments for resume after the DO wakes.
 */
import {
  DurableObjectSqliteSyncWrapper,
  SQLiteSyncStorage,
  TLSocketRoom,
  type SessionStateSnapshot,
} from "@tldraw/sync-core";
import type { TLRecord } from "@tldraw/tlschema";
import { DurableObject } from "cloudflare:workers";
import { createLogger, parseLogLevel, type Logger } from "../logger";
import type { Env } from "../types";
import { boardSchema } from "./schema";
import { BoardInternalPaths } from "./contracts";
import { applyBoardMutation, boardMutateRequestSchema } from "./mutation";

interface SocketAttachment {
  sessionId: string;
  snapshot: SessionStateSnapshot | null;
}

export class BoardRoom extends DurableObject<Env> {
  private room: TLSocketRoom<TLRecord, void> | null = null;
  private readonly sessionIdToWs = new Map<string, WebSocket>();
  private readonly log: Logger;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.log = createLogger("board-do", {}, parseLogLevel(env.LOG_LEVEL));
    // Answer the tldraw client's edge ping without waking the DO.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}')
    );
  }

  private getOrCreateRoom(): TLSocketRoom<TLRecord, void> {
    if (this.room) return this.room;

    const sql = new DurableObjectSqliteSyncWrapper(this.ctx.storage);
    const storage = new SQLiteSyncStorage<TLRecord>({ sql });

    this.room = new TLSocketRoom<TLRecord, void>({
      schema: boardSchema,
      storage,
      // Hibernation keep-alive handles liveness on Cloudflare; the room must not
      // time sessions out on its own timer.
      clientTimeout: Infinity,
      onSessionSnapshot: (sessionId, snapshot) => {
        const ws = this.sessionIdToWs.get(sessionId);
        if (ws) ws.serializeAttachment({ sessionId, snapshot } satisfies SocketAttachment);
      },
    });

    // Re-attach sockets that survived hibernation.
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as SocketAttachment | null;
      if (!attachment?.sessionId) continue;
      this.sessionIdToWs.set(attachment.sessionId, ws);
      if (attachment.snapshot) {
        this.room.handleSocketResume({
          sessionId: attachment.sessionId,
          socket: ws,
          snapshot: attachment.snapshot,
        });
      } else {
        this.room.handleSocketConnect({ sessionId: attachment.sessionId, socket: ws });
      }
    }

    return this.room;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return this.handleConnect(request);
    }

    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === BoardInternalPaths.mutate) {
      return this.handleMutate(request);
    }
    if (request.method === "GET" && path === BoardInternalPaths.snapshot) {
      return this.handleSnapshot();
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  /** Accept a browser peer. `sessionId` is tldraw's per-connection id. */
  private handleConnect(request: Request): Response {
    const sessionId = new URL(request.url).searchParams.get("sessionId");
    if (!sessionId) {
      return Response.json({ error: "Missing sessionId" }, { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ sessionId, snapshot: null } satisfies SocketAttachment);
    this.sessionIdToWs.set(sessionId, server);

    try {
      this.getOrCreateRoom().handleSocketConnect({ sessionId, socket: server });
    } catch (e) {
      this.log.error("board.connect_failed", { event: "board.connect_failed", error: asError(e) });
      return Response.json({ error: "Board room unavailable" }, { status: 500 });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Agent server-side mutation. Atomic, broadcasts to all connected peers. */
  private async handleMutate(request: Request): Promise<Response> {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = boardMutateRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json({ error: "Invalid mutation payload" }, { status: 400 });
    }

    let room: TLSocketRoom<TLRecord, void>;
    try {
      room = this.getOrCreateRoom();
    } catch (e) {
      this.log.error("board.room_unavailable", {
        event: "board.room_unavailable",
        error: asError(e),
      });
      return Response.json({ error: "Board room unavailable" }, { status: 500 });
    }

    try {
      let result = { applied: 0, created: 0, updated: 0, deleted: 0 };
      await room.updateStore((store) => {
        result = applyBoardMutation(store, parsed.data);
      });
      this.log.info("board.mutate", {
        event: "board.mutate",
        created: result.created,
        updated: result.updated,
        deleted: result.deleted,
      });
      return Response.json(result);
    } catch (e) {
      // A record rejected by the room schema throws inside the transaction, which
      // does not commit — nothing in the batch is applied.
      this.log.warn("board.mutate_rejected", {
        event: "board.mutate_rejected",
        error: asError(e),
      });
      return Response.json({ error: "Mutation rejected by board schema" }, { status: 400 });
    }
  }

  /** Authoritative document read, for the agent's save-to-GitHub `.tldr` export. */
  private handleSnapshot(): Response {
    try {
      const snapshot = this.getOrCreateRoom().getCurrentSnapshot();
      return Response.json(snapshot);
    } catch (e) {
      this.log.error("board.snapshot_failed", {
        event: "board.snapshot_failed",
        error: asError(e),
      });
      // Never return an empty document on failure: the agent must be able to tell
      // "board is unreachable" apart from "board is legitimately empty".
      return Response.json({ error: "Board room unavailable" }, { status: 500 });
    }
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const sessionId = this.sessionIdFor(ws);
    if (!sessionId) return;
    this.sessionIdToWs.set(sessionId, ws);
    this.getOrCreateRoom().handleSocketMessage(sessionId, message);
  }

  override webSocketClose(ws: WebSocket): void {
    this.endSocket(ws, "close");
  }

  override webSocketError(ws: WebSocket): void {
    this.endSocket(ws, "error");
  }

  private endSocket(ws: WebSocket, reason: "close" | "error"): void {
    const sessionId = this.sessionIdFor(ws);
    if (!sessionId) return;
    this.sessionIdToWs.delete(sessionId);
    const room = this.getOrCreateRoom();
    if (reason === "error") room.handleSocketError(sessionId);
    else room.handleSocketClose(sessionId);
  }

  private sessionIdFor(ws: WebSocket): string | null {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    return attachment?.sessionId ?? null;
  }
}

function asError(e: unknown): Error | string {
  return e instanceof Error ? e : String(e);
}
