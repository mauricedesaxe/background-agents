import type { Session } from "@open-inspect/shared";
import { formatRepoLabel, NO_REPOSITORY_LABEL } from "./repo-label";
import { isInactiveSession } from "./time";

export const SESSIONS_PAGE_SIZE = 50;
export const SESSIONS_API_PATH = "/api/sessions";
export const CURRENT_USER_CREATED_BY = "me";
export const SIDEBAR_SESSIONS_KEY = buildSessionsPageKey({
  excludeStatus: "archived",
  limit: SESSIONS_PAGE_SIZE,
  offset: 0,
});

export interface SessionListResponse {
  sessions: Session[];
  hasMore: boolean;
}

export type SessionSourceFilter = "manual" | "automatic";

export interface SessionRepositoryGroup {
  key: string;
  label: string;
  activeSessions: Session[];
  inactiveSessions: Session[];
}

export interface GroupedSessionList {
  groups: SessionRepositoryGroup[];
  childrenMap: Map<string, Session[]>;
  hasFilteredSessions: boolean;
}

const MULTIPLE_REPOSITORIES_KEY = "multiple-repositories";
const MULTIPLE_REPOSITORIES_LABEL = "Multiple repositories";
const NO_REPOSITORY_KEY = "no-repository";

export function buildGroupedSessionList(
  sessions: Session[],
  {
    sourceFilter,
    searchQuery,
    now,
  }: { sourceFilter: SessionSourceFilter; searchQuery: string; now: number }
): GroupedSessionList {
  const sorted = sessions
    .filter((session) => session.status !== "archived")
    .sort((a, b) => sessionActivity(b) - sessionActivity(a));
  const sessionsById = new Map(sorted.map((session) => [session.id, session]));
  const allChildren = new Map<string, Session[]>();
  const roots: Session[] = [];

  for (const session of sorted) {
    if (!session.parentSessionId || !sessionsById.has(session.parentSessionId)) {
      roots.push(session);
      continue;
    }

    const siblings = allChildren.get(session.parentSessionId) ?? [];
    siblings.push(session);
    allChildren.set(session.parentSessionId, siblings);
  }

  const query = searchQuery.trim().toLowerCase();
  const visibleIds = new Set<string>();
  const filteredRoots = roots.filter((root) => {
    const isAutomatic = root.spawnSource === "automation";
    if ((sourceFilter === "automatic") !== isAutomatic) return false;

    if (!query) {
      addSubtreeIds(root.id, allChildren, visibleIds, new Set());
      return true;
    }

    return addMatchingSubtreeIds(root.id, query, sessionsById, allChildren, visibleIds, new Set());
  });
  const childrenMap = visibleChildrenMap(allChildren, visibleIds);
  const groupsByKey = new Map<string, SessionRepositoryGroup>();

  for (const root of filteredRoots) {
    const { key, label } = repositoryGroup(root);
    const group = groupsByKey.get(key) ?? {
      key,
      label,
      activeSessions: [],
      inactiveSessions: [],
    };

    if (isInactiveSession(sessionActivity(root), now)) {
      group.inactiveSessions.push(root);
    } else {
      group.activeSessions.push(root);
    }
    groupsByKey.set(key, group);
  }

  const groups = [...groupsByKey.values()]
    .filter((group) => group.activeSessions.length > 0 || query.length > 0)
    .sort((a, b) => groupActivity(b) - groupActivity(a));

  return {
    groups,
    childrenMap,
    hasFilteredSessions: groups.length > 0,
  };
}

function sessionActivity(session: Session) {
  return session.updatedAt || session.createdAt;
}

function addSubtreeIds(
  sessionId: string,
  childrenMap: Map<string, Session[]>,
  visibleIds: Set<string>,
  visitedIds: Set<string>
) {
  if (visitedIds.has(sessionId)) return;
  visitedIds.add(sessionId);
  visibleIds.add(sessionId);
  for (const child of childrenMap.get(sessionId) ?? []) {
    addSubtreeIds(child.id, childrenMap, visibleIds, visitedIds);
  }
}

function addMatchingSubtreeIds(
  sessionId: string,
  query: string,
  sessionsById: Map<string, Session>,
  childrenMap: Map<string, Session[]>,
  visibleIds: Set<string>,
  visitedIds: Set<string>
): boolean {
  if (visitedIds.has(sessionId)) return false;
  visitedIds.add(sessionId);

  const children = childrenMap.get(sessionId) ?? [];
  const matchingChildren = children.filter((child) =>
    addMatchingSubtreeIds(child.id, query, sessionsById, childrenMap, visibleIds, visitedIds)
  );
  const session = sessionsById.get(sessionId);
  const matches = session ? sessionMatchesQuery(session, query) : false;
  if (!matches && matchingChildren.length === 0) return false;

  visibleIds.add(sessionId);
  return true;
}

function sessionMatchesQuery(session: Session, query: string) {
  if (session.title?.toLowerCase().includes(query)) return true;
  return sessionRepositories(session).some((repo) =>
    formatRepoLabel(repo.repoOwner, repo.repoName).toLowerCase().includes(query)
  );
}

function visibleChildrenMap(allChildren: Map<string, Session[]>, visibleIds: Set<string>) {
  const visibleChildren = new Map<string, Session[]>();
  for (const [parentId, children] of allChildren) {
    if (!visibleIds.has(parentId)) continue;
    const visible = children.filter((child) => visibleIds.has(child.id));
    if (visible.length > 0) visibleChildren.set(parentId, visible);
  }
  return visibleChildren;
}

function repositoryGroup(session: Session) {
  const repositories = sessionRepositories(session);
  if (repositories.length > 1) {
    return { key: MULTIPLE_REPOSITORIES_KEY, label: MULTIPLE_REPOSITORIES_LABEL };
  }
  if (repositories.length === 0) {
    return { key: NO_REPOSITORY_KEY, label: NO_REPOSITORY_LABEL };
  }
  const label = formatRepoLabel(repositories[0].repoOwner, repositories[0].repoName);
  return { key: `repository:${label}`, label };
}

function sessionRepositories(session: Session) {
  if (session.repositories?.length) return session.repositories;
  if (!session.repoOwner || !session.repoName) return [];
  return [{ repoOwner: session.repoOwner, repoName: session.repoName }];
}

function groupActivity(group: SessionRepositoryGroup) {
  const newest = group.activeSessions[0] ?? group.inactiveSessions[0];
  return newest ? sessionActivity(newest) : 0;
}

export function buildSessionsPageKey({
  limit = SESSIONS_PAGE_SIZE,
  offset = 0,
  status,
  excludeStatus,
  createdBy,
}: {
  limit?: number;
  offset?: number;
  status?: string;
  excludeStatus?: string;
  createdBy?: readonly string[];
}) {
  const searchParams = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });

  if (status) {
    searchParams.set("status", status);
  }

  if (excludeStatus) {
    searchParams.set("excludeStatus", excludeStatus);
  }

  for (const userId of createdBy ?? []) {
    searchParams.append("createdBy", userId);
  }

  return `${SESSIONS_API_PATH}?${searchParams.toString()}`;
}

export function isSessionListKey(key: unknown): key is string {
  return (
    typeof key === "string" &&
    (key === SESSIONS_API_PATH || key.startsWith(`${SESSIONS_API_PATH}?`))
  );
}

export function isUnarchivedSessionListKey(key: unknown): key is string {
  if (!isSessionListKey(key)) return false;

  const url = new URL(key, "http://localhost");
  return url.searchParams.get("status") !== "archived";
}

export function isArchivedSessionListKey(key: unknown): key is string {
  if (!isSessionListKey(key)) return false;

  const url = new URL(key, "http://localhost");
  return url.searchParams.get("status") === "archived";
}

// Extracted from session-sidebar so the cache-shape transformation can be unit
// tested without rendering the component or going through Radix/SWR.
export function applyTitleUpdate(
  data: SessionListResponse | undefined,
  sessionId: string,
  title: string,
  updatedAt: number
): SessionListResponse | undefined {
  if (!data) return data;
  return {
    ...data,
    sessions: data.sessions.map((session) =>
      session.id === sessionId ? { ...session, title, updatedAt } : session
    ),
  };
}

export function mergeUniqueSessions(existing: Session[], incoming: Session[]) {
  const seen = new Set(existing.map((session) => session.id));
  const merged = [...existing];

  for (const session of incoming) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    merged.push(session);
  }

  return merged;
}

export function removeSessionFromList(sessions: Session[], sessionId: string) {
  return sessions.filter((session) => session.id !== sessionId);
}

/**
 * Collect a session id and all of its descendants (children, grandchildren, …)
 * from a flat session list, following `parentSessionId` links.
 *
 * Archiving a parent cascades to its child/sub-task sessions on the server
 * (they all become `archived`), so the sidebar must drop the whole subtree, not
 * just the archived row — otherwise the children linger as orphaned "sub-task"
 * entries until the next full refetch. Iterates to a fixed point so any nesting
 * depth and child ordering are handled; descendants not currently loaded are
 * reconciled by the next server-truth fetch.
 */
export function collectSessionAndDescendantIds(
  sessions: Session[],
  sessionId: string
): Set<string> {
  const ids = new Set<string>([sessionId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const session of sessions) {
      if (ids.has(session.id)) continue;
      if (session.parentSessionId && ids.has(session.parentSessionId)) {
        ids.add(session.id);
        changed = true;
      }
    }
  }
  return ids;
}
