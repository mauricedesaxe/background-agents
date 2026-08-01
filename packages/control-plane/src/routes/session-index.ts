import { isCanonicalUserId, type SessionStatus } from "@open-inspect/shared";
import { z } from "zod";
import {
  SessionIndexStore,
  type SessionListCursor,
  type SessionReadUpdate,
} from "../db/session-index";
import { error, json, parsePattern, type RequestContext, type Route } from "./shared";
import { epochMs } from "../time";
import type { Env } from "../types";

const SESSION_STATUSES: SessionStatus[] = [
  "created",
  "active",
  "completed",
  "failed",
  "archived",
  "cancelled",
];
const sessionListCursorSchema = z.tuple([z.number().int().nonnegative(), z.string().min(1)]);

function encodeSessionListCursor(cursor: SessionListCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify([cursor.updatedAt, cursor.id]));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function parseSessionListCursor(value: string): SessionListCursor | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;

  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    const parsed = sessionListCursorSchema.safeParse(JSON.parse(decoded));
    if (!parsed.success) return null;
    return { updatedAt: epochMs(parsed.data[0]), id: parsed.data[1] };
  } catch {
    return null;
  }
}

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
  const modeParam = url.searchParams.get("mode");
  const mode = modeParam === null || modeParam === "flat" ? "flat" : modeParam;
  const cursorParam = url.searchParams.get("cursor");
  const statusParam = url.searchParams.get("status");
  const excludeStatusParam = url.searchParams.get("excludeStatus");
  const status = parseSessionStatus(statusParam);
  const excludeStatus = parseSessionStatus(excludeStatusParam);
  const createdByUserIds = parseCreatedByFilters(url.searchParams);

  if (mode !== "flat" && mode !== "tree") {
    return error("Invalid mode", 400);
  }

  const cursor =
    mode === "tree" && cursorParam !== null ? parseSessionListCursor(cursorParam) : undefined;
  if (mode === "tree" && cursorParam !== null && !cursor) {
    return error("Invalid cursor", 400);
  }

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
    mode,
    cursor: cursor ?? undefined,
    viewerUserId: viewerUserId ?? undefined,
  });

  return json({
    sessions: result.sessions,
    hasMore: result.hasMore,
    ...(mode === "tree"
      ? { nextCursor: result.nextCursor ? encodeSessionListCursor(result.nextCursor) : null }
      : {}),
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
