import {
  DEFAULT_SESSION_LIST_LIMIT,
  DEFAULT_SESSION_LIST_OFFSET,
  serializeSessionListQuery,
  SESSION_LIST_CURRENT_USER,
  type SessionListQuery,
} from "@open-inspect/shared/session-list-query";
import type { SessionListItem as SessionItem } from "@open-inspect/shared/types/session-inbox";
import { sessionStatusSchema } from "@open-inspect/shared/types/sessions";
import { z } from "zod";
import { browserApiFetch, type BrowserApiPath } from "./browser-api-fetch";
import { formatRepoLabel, NO_REPOSITORY_LABEL } from "./repo-label";

const SESSIONS_PAGE_SIZE = DEFAULT_SESSION_LIST_LIMIT;
const COMMAND_MENU_SESSIONS_LIMIT = 100;
const SESSIONS_API_PATH = "/api/sessions";
export const CURRENT_USER_CREATED_BY = SESSION_LIST_CURRENT_USER;
export const SIDEBAR_SESSIONS_KEY = buildSessionsPageKey({
  excludeStatus: "archived",
  limit: SESSIONS_PAGE_SIZE,
  offset: 0,
});
export const COMMAND_MENU_SESSIONS_KEY = buildSessionsPageKey({
  excludeStatus: "archived",
  limit: COMMAND_MENU_SESSIONS_LIMIT,
});

const sessionListItemSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  repoOwner: z.string().nullable(),
  repoName: z.string().nullable(),
  status: sessionStatusSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  repositories: z
    .array(
      z.object({
        repoOwner: z.string(),
        repoName: z.string(),
        repoId: z.number().nullable(),
        baseBranch: z.string(),
      })
    )
    .optional(),
  readState: z
    .union([
      z.object({
        latestMessageId: z.null(),
        unread: z.literal(false),
        version: z.number().default(0),
      }),
      z.object({
        latestMessageId: z.string(),
        unread: z.boolean(),
        version: z.number().default(0),
      }),
    ])
    .optional(),
});

export type SessionListItem = z.infer<typeof sessionListItemSchema>;

const sessionListResponseSchema = z.object({
  sessions: z.array(sessionListItemSchema),
  hasMore: z.boolean(),
});

export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;

export async function fetchSessionListPage(path: BrowserApiPath): Promise<SessionListResponse> {
  const response = await browserApiFetch(path);
  if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
  return sessionListResponseSchema.parse(await response.json());
}

export function buildSessionsPageKey(options: SessionListQuery = {}): BrowserApiPath {
  const searchParams = serializeSessionListQuery({
    ...options,
    limit: options.limit ?? DEFAULT_SESSION_LIST_LIMIT,
    offset: options.offset ?? DEFAULT_SESSION_LIST_OFFSET,
  });

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
  title: string | null
): SessionListResponse | undefined {
  if (!data) return data;
  return {
    ...data,
    sessions: data.sessions.map((session) =>
      session.id === sessionId ? { ...session, title } : session
    ),
  };
}

export function removeSessionFromList(sessions: SessionListItem[], sessionId: string) {
  return sessions.filter((session) => session.id !== sessionId);
}

export function buildSessionSearchValue(session: SessionListItem): string {
  const repositoryLabels = session.repositories?.length
    ? session.repositories.map((repository) =>
        formatRepoLabel(repository.repoOwner, repository.repoName)
      )
    : [formatRepoLabel(session.repoOwner, session.repoName)];

  return [session.id, session.title, ...repositoryLabels].filter(Boolean).join(" ");
}

/**
 * The session-detail route for a list entry, carrying the repo and title as
 * query params so the destination page can render its header before the
 * session payload loads.
 */
export function buildSessionHref(
  session: Pick<SessionListItem, "id" | "title" | "repoOwner" | "repoName">
) {
  const query: Record<string, string> = {};
  if (session.repoOwner && session.repoName) {
    query.repoOwner = session.repoOwner;
    query.repoName = session.repoName;
  }
  if (session.title) {
    query.title = session.title;
  }

  return {
    pathname: `/session/${session.id}`,
    query,
  };
}

export type SessionSourceFilter = "manual" | "automatic";

export interface SessionSourceBucket {
  source: SessionSourceFilter;
  sessions: SessionItem[];
}

export interface SessionRepositoryGroup {
  key: string;
  label: string;
  buckets: SessionSourceBucket[];
}

const MULTIPLE_REPOSITORIES_KEY = "multiple-repositories";
const MULTIPLE_REPOSITORIES_LABEL = "Multiple repositories";
const NO_REPOSITORY_KEY = "no-repository";
const SOURCE_ORDER: SessionSourceFilter[] = ["manual", "automatic"];

/**
 * Group one status section's root sessions by repository, and split each repo
 * group into manual and automatic sub-buckets. Upstream paginates the section
 * server-side; this layers the repo and source axes over the roots the server
 * already returned, preserving their recency order within each bucket.
 */
export function buildGroupedSessionList(sessions: SessionItem[]): SessionRepositoryGroup[] {
  const groupsByKey = new Map<string, SessionRepositoryGroup>();

  for (const session of sessions) {
    const { key, label } = repositoryGroup(session);
    const group = groupsByKey.get(key) ?? { key, label, buckets: [] };
    const source = sessionSource(session);
    const bucket = group.buckets.find((candidate) => candidate.source === source);
    if (bucket) {
      bucket.sessions.push(session);
    } else {
      group.buckets.push({ source, sessions: [session] });
    }
    groupsByKey.set(key, group);
  }

  const groups = [...groupsByKey.values()];
  for (const group of groups) {
    group.buckets.sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source));
  }
  return groups.sort((a, b) => groupActivity(b) - groupActivity(a));
}

/** A session the user started is manual; automation and bots are automatic. */
function sessionSource(session: Pick<SessionItem, "spawnSource">): SessionSourceFilter {
  return session.spawnSource === "user" ? "manual" : "automatic";
}

function sessionActivity(session: Pick<SessionItem, "updatedAt" | "createdAt">) {
  return session.updatedAt || session.createdAt;
}

function groupActivity(group: SessionRepositoryGroup) {
  let newest = 0;
  for (const bucket of group.buckets) {
    for (const session of bucket.sessions) {
      newest = Math.max(newest, sessionActivity(session));
    }
  }
  return newest;
}

function repositoryGroup(session: SessionItem) {
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

function sessionRepositories(session: SessionItem) {
  if (session.repositories?.length) return session.repositories;
  if (!session.repoOwner || !session.repoName) return [];
  return [{ repoOwner: session.repoOwner, repoName: session.repoName }];
}
