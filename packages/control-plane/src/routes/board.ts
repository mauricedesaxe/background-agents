/**
 * Board routes — the agent's server-side interface to interactive tldraw boards.
 *
 * Create persists a `board` artifact on the session (which broadcasts
 * `artifact_created` to the web client, exactly like every other artifact).
 * Mutate and snapshot forward to the BoardRoom Durable Object keyed by boardId.
 * Inspect mints a short-lived, read-only browser URL. All four are
 * sandbox-authenticated with the agent's `SANDBOX_AUTH_TOKEN`; browser sockets
 * use participant or board-scoped inspection tokens in index.ts.
 */
import { generateId } from "../auth/crypto";
import { createLogger } from "../logger";
import { BoardInternalPaths, buildBoardInternalUrl } from "../board/contracts";
import { mintBoardInspectionToken } from "../board/inspection-token";
import { SessionInternalPaths } from "../session/contracts";
import { createSessionRuntimeClient } from "../session/runtime-client";
import type { Env } from "../types";
import {
  error,
  json,
  parsePattern,
  type RequestContext,
  type Route,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
} from "./shared";

const logger = createLogger("board-routes");

/** Board title cap — a label, not a document. */
const BOARD_TITLE_MAX_LENGTH = 200;
const DEFAULT_BOARD_TITLE = "Whiteboard";
const BOARD_INSPECTION_TOKEN_TTL_MS = 2 * 60 * 1000;

interface ArtifactSummary {
  type: string;
  metadata: Record<string, unknown> | null;
}

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

export function hasBoardArtifact(artifacts: ArtifactSummary[], boardId: string): boolean {
  return artifacts.some(
    (artifact) => artifact.type === "board" && artifact.metadata?.boardId === boardId
  );
}

export function buildBoardInspectionUrl(
  webAppUrl: string,
  sessionId: string,
  boardId: string,
  token: string
): string {
  const base = webAppUrl.replace(/\/$/, "");
  return `${base}/board/inspect/${encodeURIComponent(sessionId)}/${encodeURIComponent(boardId)}#token=${encodeURIComponent(token)}`;
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

async function handleInspectBoard(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  const boardId = match.groups?.boardId;
  if (!sessionId || !boardId) return error("Session ID and board ID required", 400);
  if (!env.WEB_APP_URL) return error("Board inspection is not configured", 503);

  const artifactsResponse = await createSessionRuntimeClient(env, ctx).fetch(
    sessionId,
    SessionInternalPaths.artifacts
  );
  if (!artifactsResponse.ok) return error("Failed to verify board", 503);

  let artifacts: ArtifactSummary[];
  try {
    const body = (await artifactsResponse.json()) as { artifacts?: unknown };
    artifacts = Array.isArray(body.artifacts) ? (body.artifacts as ArtifactSummary[]) : [];
  } catch {
    return error("Failed to verify board", 503);
  }
  if (!hasBoardArtifact(artifacts, boardId)) return error("Board not found", 404);

  const token = await mintBoardInspectionToken(
    { sessionId, boardId, expiresAtMs: Date.now() + BOARD_INSPECTION_TOKEN_TTL_MS },
    env.TOKEN_ENCRYPTION_KEY
  );
  return json({ url: buildBoardInspectionUrl(env.WEB_APP_URL, sessionId, boardId, token) });
}

export const boardRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/sessions/:id/board"),
    handler: handleCreateBoard,
    ...SCM_AGNOSTIC_SANDBOX_ROUTE,
  },
  {
    method: "POST",
    pattern: parsePattern("/sessions/:id/board/:boardId/mutate"),
    handler: handleMutateBoard,
    ...SCM_AGNOSTIC_SANDBOX_ROUTE,
  },
  {
    method: "GET",
    pattern: parsePattern("/sessions/:id/board/:boardId/snapshot"),
    handler: handleBoardSnapshot,
    ...SCM_AGNOSTIC_SANDBOX_ROUTE,
  },
  {
    method: "POST",
    pattern: parsePattern("/sessions/:id/board/:boardId/inspect"),
    handler: handleInspectBoard,
    ...SCM_AGNOSTIC_SANDBOX_ROUTE,
  },
];
