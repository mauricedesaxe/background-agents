import { SessionIndexStore } from "../db/session-index";
import { SessionInternalPaths } from "../session/contracts";
import type { Env } from "../types";
import { error, json, parsePattern, type RequestContext, type Route } from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";

async function handleListChildren(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const parentId = match.groups?.id;
  if (!parentId) return error("Parent session ID required");

  const sessionStore = new SessionIndexStore(ctx.db);
  const children = await sessionStore.listByParent(parentId);

  return json({ children });
}

async function handleGetChild(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const parentId = match.groups?.id;
  const childId = match.groups?.childId;
  if (!parentId || !childId) return error("Parent and child session IDs required");

  const sessionStore = new SessionIndexStore(ctx.db);
  const isChild = await sessionStore.isChildOf(childId, parentId);
  if (!isChild) {
    return error("Child session not found", 404);
  }

  const url = new URL(request.url);
  return ctx.sessionRuntime.fetch(
    childId,
    SessionInternalPaths.childSummary,
    undefined,
    url.search
  );
}

export async function handleCancelChild(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const parentId = match.groups?.id;
  const childId = match.groups?.childId;
  if (!parentId || !childId) return error("Parent and child session IDs required");

  const sessionStore = new SessionIndexStore(ctx.db);
  const isChild = await sessionStore.isChildOf(childId, parentId);
  if (!isChild) {
    return error("Child session not found", 404);
  }

  const response = await requestCancellation(ctx, childId);

  const descendantIds = await sessionStore.listActiveDescendantIds(childId);
  const cancelledDescendantIds: string[] = [];
  const failedSessionIds = response.ok || response.status === 409 ? [] : [childId];
  for (const descendantId of descendantIds) {
    const descendantResponse = await requestCancellation(ctx, descendantId);
    if (descendantResponse.ok) {
      cancelledDescendantIds.push(descendantId);
    } else if (descendantResponse.status !== 409) {
      failedSessionIds.push(descendantId);
    }
  }

  if (failedSessionIds.length > 0) {
    return json(
      {
        error: `Tasks could not be cancelled: ${failedSessionIds.join(", ")}`,
        cancelledDescendantIds,
      },
      502
    );
  }

  if (response.ok || cancelledDescendantIds.length > 0) {
    return json({ status: "cancelled", cancelledDescendantIds });
  }

  return response;
}

async function requestCancellation(ctx: SessionRouteContext, sessionId: string): Promise<Response> {
  try {
    return await ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.cancel, {
      method: "POST",
    });
  } catch {
    return error("Cancellation request failed", 502);
  }
}

export const sessionChildRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/sessions/:id/children"),
    handler: handleListChildren,
  },
  sessionRoute({
    method: "GET",
    pattern: parsePattern("/sessions/:id/children/:childId"),
    handler: handleGetChild,
  }),
  sessionRoute({
    method: "POST",
    pattern: parsePattern("/sessions/:id/children/:childId/cancel"),
    handler: handleCancelChild,
  }),
];
