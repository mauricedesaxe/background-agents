import { isCanonicalUserId, type SessionStatus } from "@open-inspect/shared";
import { SessionIndexStore, type SessionReadUpdate } from "../db/session-index";
import { error, json, parsePattern, type RequestContext, type Route } from "./shared";
import type { Env } from "../types";

const SESSION_STATUSES: SessionStatus[] = [
  "created",
  "active",
  "completed",
  "failed",
  "archived",
  "cancelled",
];

function parseSessionStatus(value: string | null): SessionStatus | undefined {
  if (!value) return undefined;
  return SESSION_STATUSES.includes(value as SessionStatus) ? (value as SessionStatus) : undefined;
}

function parseCreatedByFilters(searchParams: URLSearchParams): string[] | Response {
  const values = searchParams.getAll("createdBy");
  const userIds: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (!isCanonicalUserId(value)) {
      return error("Invalid createdBy", 400);
    }

    if (!seen.has(value)) {
      seen.add(value);
      userIds.push(value);
    }
  }

  return userIds;
}

function parsePaginationLimit(value: string | null): number {
  const parsed = Number.parseInt(value ?? "50", 10);
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(Math.max(parsed, 1), 100);
}

function parsePaginationOffset(value: string | null): number {
  const parsed = Number.parseInt(value ?? "0", 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(parsed, 0);
}

async function handleListSessions(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const url = new URL(request.url);
  const limit = parsePaginationLimit(url.searchParams.get("limit"));
  const offset = parsePaginationOffset(url.searchParams.get("offset"));
  const statusParam = url.searchParams.get("status");
  const excludeStatusParam = url.searchParams.get("excludeStatus");
  const status = parseSessionStatus(statusParam);
  const excludeStatus = parseSessionStatus(excludeStatusParam);
  const createdByUserIds = parseCreatedByFilters(url.searchParams);

  if (statusParam && !status) {
    return error("Invalid status", 400);
  }

  if (excludeStatusParam && !excludeStatus) {
    return error("Invalid excludeStatus", 400);
  }

  if (createdByUserIds instanceof Response) {
    return createdByUserIds;
  }

  const store = new SessionIndexStore(ctx.db);
  const viewerUserId = ctx.principal?.kind === "user" ? ctx.principal.user.canonicalUserId : null;
  const result = await store.list({
    status,
    excludeStatus,
    createdByUserIds,
    limit,
    offset,
    viewerUserId: viewerUserId ?? undefined,
  });

  return json({
    sessions: result.sessions,
    hasMore: result.hasMore,
  });
}

async function handleUpdateReadState(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  const userId = ctx.principal?.kind === "user" ? ctx.principal.user.canonicalUserId : null;
  if (!userId) return error("User identity required", 403);

  let body: { action?: unknown; messageId?: unknown };
  try {
    body = (await request.json()) as { action?: unknown; messageId?: unknown };
  } catch {
    return error("Invalid request body", 400);
  }
  if (body.action !== "viewed" && body.action !== "mark_read" && body.action !== "mark_unread") {
    return error("Invalid read-state action", 400);
  }
  if (body.action === "viewed" && typeof body.messageId !== "string") {
    return error("Viewed output message ID required", 400);
  }

  const update: SessionReadUpdate =
    body.action === "viewed"
      ? { action: body.action, messageId: body.messageId as string }
      : { action: body.action };

  const unread = await new SessionIndexStore(ctx.db).updateReadState(sessionId, userId, update);
  if (unread === null) return error("Session not found", 404);
  return json({ sessionId, unread });
}

async function handleDeleteSession(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  const sessionStore = new SessionIndexStore(ctx.db);
  await sessionStore.delete(sessionId);

  return json({ status: "deleted", sessionId });
}

export const sessionIndexRoutes: Route[] = [
  { method: "GET", pattern: parsePattern("/sessions"), handler: handleListSessions },
  {
    method: "PATCH",
    pattern: parsePattern("/sessions/:id/read-state"),
    handler: handleUpdateReadState,
  },
  { method: "DELETE", pattern: parsePattern("/sessions/:id"), handler: handleDeleteSession },
];
