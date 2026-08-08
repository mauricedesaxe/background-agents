import type {
  PullRequestSummary,
  SessionListRepository,
  SessionStatus,
  SpawnSource,
} from "@open-inspect/shared";
import { SessionPullRequestStore } from "./session-pull-request-store";
import type { SqlDatabase } from "./sql-database";
import { epochMs, type EpochMs } from "../time";

const TERMINAL_STATUSES: readonly SessionStatus[] = [
  "completed",
  "failed",
  "archived",
  "cancelled",
];
const TERMINAL_STATUS_SQL = TERMINAL_STATUSES.map((status) => `'${status}'`).join(", ");

export function sessionAcceptsChildSpawns(status: SessionStatus): boolean {
  return !TERMINAL_STATUSES.includes(status);
}

/**
 * One member of a session's repository set — the identity subset of the
 * shared SessionRepositoryState (no git state; D1 doesn't store it).
 * Ordered — array position is the persisted `position` column ([0] =
 * primary, mirrored into the scalar repo_owner/repo_name columns). Aliases
 * the shared wire type so Session.repositories and this share one shape.
 */
export type SessionIndexRepository = SessionListRepository;

export interface SessionEntry {
  id: string;
  title: string | null;
  repoOwner: string | null;
  repoName: string | null;
  model: string;
  reasoningEffort: string | null;
  baseBranch: string | null;
  status: SessionStatus;
  parentSessionId?: string | null;
  spawnSource?: SpawnSource;
  spawnDepth?: number;
  automationId?: string | null;
  automationRunId?: string | null;
  scmLogin?: string | null;
  userId?: string | null;
  totalCost?: number;
  activeDurationMs?: number;
  messageCount?: number;
  prCount?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  createdAt: number;
  updatedAt: number;
  /**
   * Ordered member list; [0] = primary. Absent on pre-feature sessions —
   * consumers synthesize from repoOwner/repoName.
   */
  repositories?: SessionIndexRepository[];
  /**
   * The environment this session was launched from (provenance), or null for
   * repo-launched/ad-hoc sessions. PR-12 renders it on the session list.
   */
  environmentId?: string | null;
  /**
   * Per-status PR counts from session_pull_requests; absent when the session
   * has no tracked PRs. Attached by list() for the global sidebar.
   */
  pullRequestSummary?: PullRequestSummary;
  unread?: boolean;
}

interface SessionRepositoryRow {
  session_id: string;
  position: number;
  repo_owner: string;
  repo_name: string;
  repo_id: number | null;
  base_branch: string;
}

interface SessionRow {
  id: string;
  title: string | null;
  repo_owner: string | null;
  repo_name: string | null;
  model: string;
  reasoning_effort: string | null;
  base_branch: string | null;
  status: SessionStatus;
  parent_session_id: string | null;
  spawn_source: SpawnSource;
  spawn_depth: number;
  automation_id: string | null;
  automation_run_id: string | null;
  scm_login: string | null;
  user_id: string | null;
  total_cost: number;
  active_duration_ms: number;
  message_count: number;
  pr_count: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  environment_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface ListSessionsOptions {
  status?: SessionStatus;
  excludeStatus?: SessionStatus;
  repoOwner?: string;
  repoName?: string;
  createdByUserIds?: readonly string[];
  limit?: number;
  offset?: number;
  mode?: "flat" | "tree";
  cursor?: SessionListCursor;
  viewerUserId?: string;
}

export interface SessionListCursor {
  updatedAt: EpochMs;
  id: string;
}

export type SessionReadUpdate =
  | { action: "viewed"; messageId: string }
  | { action: "mark_read" | "mark_unread" };

export interface ListSessionsResult {
  sessions: SessionEntry[];
  hasMore: boolean;
  nextCursor?: SessionListCursor | null;
}

interface TreeSessionRow extends SessionRow {
  is_base: number;
  candidate_count: number;
}

function toEntry(row: SessionRow): SessionEntry {
  return {
    id: row.id,
    title: row.title,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    baseBranch: row.base_branch,
    status: row.status,
    parentSessionId: row.parent_session_id,
    spawnSource: row.spawn_source,
    spawnDepth: row.spawn_depth,
    automationId: row.automation_id,
    automationRunId: row.automation_run_id,
    scmLogin: row.scm_login,
    userId: row.user_id,
    totalCost: row.total_cost,
    activeDurationMs: row.active_duration_ms,
    messageCount: row.message_count,
    prCount: row.pr_count,
    totalTokens: row.total_tokens,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    environmentId: row.environment_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeRepoIdentifier(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function normalizeSessionRepository(session: SessionEntry): {
  repoOwner: string | null;
  repoName: string | null;
  baseBranch: string | null;
} {
  const repoOwner = normalizeRepoIdentifier(session.repoOwner);
  const repoName = normalizeRepoIdentifier(session.repoName);

  if ((repoOwner === null) !== (repoName === null)) {
    throw new Error("Session repository must include repoOwner and repoName together");
  }

  return {
    repoOwner,
    repoName,
    baseBranch: repoOwner && repoName ? session.baseBranch : null,
  };
}

export class SessionReplayConflictError extends Error {
  constructor(sessionId: string) {
    super(`Session ID ${sessionId} belongs to another session`);
    this.name = "SessionReplayConflictError";
  }
}

export class ParentSessionSpawnRejectedError extends Error {
  constructor(parentSessionId: string) {
    super(`Parent session ${parentSessionId} no longer accepts child sessions`);
    this.name = "ParentSessionSpawnRejectedError";
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint|constraint failed|duplicate/i.test(message);
}

export class SessionIndexStore {
  constructor(private readonly db: SqlDatabase) {}

  async create(session: SessionEntry): Promise<void> {
    const repository = normalizeSessionRepository(session);
    const parentSessionId = session.parentSessionId ?? null;

    const sessionStmt = this.db
      .prepare(
        `INSERT INTO sessions (id, title, repo_owner, repo_name, model, reasoning_effort, base_branch, status, parent_session_id, spawn_source, spawn_depth, automation_id, automation_run_id, scm_login, user_id, environment_id, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE ? IS NULL OR EXISTS (
           SELECT 1 FROM sessions
           WHERE id = ?
             AND status NOT IN (${TERMINAL_STATUS_SQL})
             AND spawn_closed = 0
         )`
      )
      .bind(
        session.id,
        session.title,
        repository.repoOwner,
        repository.repoName,
        session.model,
        session.reasoningEffort,
        repository.baseBranch,
        session.status,
        parentSessionId,
        session.spawnSource ?? "user",
        session.spawnDepth ?? 0,
        session.automationId ?? null,
        session.automationRunId ?? null,
        session.scmLogin ?? null,
        session.userId ?? null,
        session.environmentId ?? null,
        session.createdAt,
        session.updatedAt,
        parentSessionId,
        parentSessionId
      );

    const repositoryStmts = (session.repositories ?? []).map((repo, position) =>
      this.db
        .prepare(
          `INSERT INTO session_repositories (session_id, position, repo_owner, repo_name, repo_id, base_branch)
           SELECT ?, ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ?)`
        )
        .bind(
          session.id,
          position,
          normalizeRepoIdentifier(repo.repoOwner),
          normalizeRepoIdentifier(repo.repoName),
          repo.repoId,
          repo.baseBranch,
          session.id
        )
    );

    try {
      const [result] = await this.db.batch([sessionStmt, ...repositoryStmts]);
      if ((result.meta.changes ?? 0) === 0 && parentSessionId) {
        throw new ParentSessionSpawnRejectedError(parentSessionId);
      }
    } catch (error) {
      if (error instanceof ParentSessionSpawnRejectedError) throw error;
      if (!isDuplicateKeyError(error)) throw error;
      await this.verifyReplay(session, repository);
    }
  }

  private async verifyReplay(
    session: SessionEntry,
    repository: ReturnType<typeof normalizeSessionRepository>
  ): Promise<void> {
    const existing = await this.get(session.id);
    if (!existing) throw new SessionReplayConflictError(session.id);

    const existingRepositories =
      (await this.repositoriesForSessions([session.id])).get(session.id) ?? [];
    const requestedRepositories = session.repositories ?? [];
    const repositoriesMatch =
      existingRepositories.length === requestedRepositories.length &&
      existingRepositories.every((repo, index) => {
        const requested = requestedRepositories[index];
        return (
          requested !== undefined &&
          normalizeRepoIdentifier(repo.repoOwner) ===
            normalizeRepoIdentifier(requested.repoOwner) &&
          normalizeRepoIdentifier(repo.repoName) === normalizeRepoIdentifier(requested.repoName) &&
          repo.repoId === requested.repoId &&
          repo.baseBranch === requested.baseBranch
        );
      });
    if (
      existing.repoOwner === repository.repoOwner &&
      existing.repoName === repository.repoName &&
      existing.baseBranch === repository.baseBranch &&
      existing.model === session.model &&
      existing.reasoningEffort === session.reasoningEffort &&
      existing.parentSessionId === (session.parentSessionId ?? null) &&
      existing.spawnSource === (session.spawnSource ?? "user") &&
      existing.spawnDepth === (session.spawnDepth ?? 0) &&
      existing.automationId === (session.automationId ?? null) &&
      existing.automationRunId === (session.automationRunId ?? null) &&
      existing.userId === (session.userId ?? null) &&
      existing.environmentId === (session.environmentId ?? null) &&
      repositoriesMatch
    ) {
      return;
    }
    throw new SessionReplayConflictError(session.id);
  }

  async get(id: string): Promise<SessionEntry | null> {
    const result = await this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .bind(id)
      .first<SessionRow>();

    return result ? toEntry(result) : null;
  }

  async canInitializeSession(id: string): Promise<boolean> {
    const result = await this.db
      .prepare("SELECT spawn_closed FROM sessions WHERE id = ?")
      .bind(id)
      .first<{ spawn_closed: number }>();
    return result?.spawn_closed !== 1;
  }

  async repositoriesForSession(id: string): Promise<SessionIndexRepository[]> {
    return (await this.repositoriesForSessions([id])).get(id) ?? [];
  }

  /**
   * Whether the session exists and the repository is in its repository set
   * (the scalar primary mirror or a session_repositories row). This is the
   * webhook branch-fallback gate (design §5.2): a branch-derived insert may
   * only attach to a session already associated with the event's repository.
   * Case-insensitive — provider repo identifiers are case-insensitive while
   * stored casing is display-canonical.
   */
  async isRepositoryAssociated(
    sessionId: string,
    repoOwner: string,
    repoName: string
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS ok FROM sessions
         WHERE id = ?1
           AND (
             (LOWER(repo_owner) = LOWER(?2) AND LOWER(repo_name) = LOWER(?3))
             OR EXISTS (
               SELECT 1 FROM session_repositories sr
               WHERE sr.session_id = sessions.id
                 AND LOWER(sr.repo_owner) = LOWER(?2)
                 AND LOWER(sr.repo_name) = LOWER(?3)
             )
           )`
      )
      .bind(sessionId, repoOwner, repoName)
      .first<{ ok: number }>();

    return row !== null;
  }

  async list(options: ListSessionsOptions = {}): Promise<ListSessionsResult> {
    const {
      status,
      excludeStatus,
      repoOwner,
      repoName,
      createdByUserIds,
      limit = 50,
      offset = 0,
      mode = "flat",
      cursor,
      viewerUserId,
    } = options;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status) {
      conditions.push("status = ?");
      params.push(status);
    }

    if (excludeStatus) {
      conditions.push("status != ?");
      params.push(excludeStatus);
    }

    const archivedSubtreesCte =
      excludeStatus === "archived"
        ? `WITH RECURSIVE archived_subtrees(id) AS (
             SELECT id FROM sessions WHERE status = 'archived'
             UNION
             SELECT child.id
             FROM sessions AS child
             JOIN archived_subtrees ON child.parent_session_id = archived_subtrees.id
           )`
        : "";
    if (archivedSubtreesCte) {
      conditions.push("sessions.id NOT IN (SELECT id FROM archived_subtrees)");
    }

    // Repo filters match against the membership table so a session is found
    // through ANY member, not just the scalar primary mirror. The scalar arm
    // is the fallback for pre-feature sessions without member rows.
    const normalizedRepoOwner = normalizeRepoIdentifier(repoOwner);
    const normalizedRepoName = normalizeRepoIdentifier(repoName);
    if (normalizedRepoOwner || normalizedRepoName) {
      const memberConditions: string[] = [];
      const scalarConditions: string[] = [];
      const repoFilterParams: unknown[] = [];
      if (normalizedRepoOwner) {
        memberConditions.push("sr.repo_owner = ?");
        scalarConditions.push("repo_owner = ?");
        repoFilterParams.push(normalizedRepoOwner);
      }
      if (normalizedRepoName) {
        memberConditions.push("sr.repo_name = ?");
        scalarConditions.push("repo_name = ?");
        repoFilterParams.push(normalizedRepoName);
      }
      conditions.push(
        `(EXISTS (SELECT 1 FROM session_repositories sr WHERE sr.session_id = sessions.id AND ${memberConditions.join(" AND ")}) OR (${scalarConditions.join(" AND ")}))`
      );
      params.push(...repoFilterParams, ...repoFilterParams);
    }

    if (createdByUserIds?.length) {
      conditions.push(`user_id IN (${createdByUserIds.map(() => "?").join(", ")})`);
      params.push(...createdByUserIds);
    }

    if (mode === "tree" && cursor) {
      conditions.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
      params.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    if (mode === "tree") {
      const recursiveCtes = [
        ...(archivedSubtreesCte ? [archivedSubtreesCte.replace("WITH RECURSIVE ", "")] : []),
        `base_candidates AS (
           SELECT * FROM sessions ${where}
           ORDER BY updated_at DESC, id DESC
           LIMIT ?
         )`,
        `base AS (
           SELECT * FROM base_candidates
           ORDER BY updated_at DESC, id DESC
           LIMIT ?
         )`,
        `ancestors(id) AS (
           SELECT parent_session_id FROM base WHERE parent_session_id IS NOT NULL
           UNION
           SELECT parent.parent_session_id
           FROM sessions AS parent
           JOIN ancestors ON parent.id = ancestors.id
           WHERE parent.parent_session_id IS NOT NULL
         )`,
        `page_ids(id) AS (
           SELECT id FROM base
           UNION
           SELECT id FROM ancestors
         )`,
      ];
      const archiveClosureFilter = archivedSubtreesCte
        ? "WHERE sessions.id NOT IN (SELECT id FROM archived_subtrees)"
        : "";
      const result = await this.db
        .prepare(
          `WITH RECURSIVE ${recursiveCtes.join(", ")}
           SELECT sessions.*,
                  CASE WHEN base.id IS NULL THEN 0 ELSE 1 END AS is_base,
                  (SELECT COUNT(*) FROM base_candidates) AS candidate_count
           FROM page_ids
           JOIN sessions ON sessions.id = page_ids.id
           LEFT JOIN base ON base.id = sessions.id
           ${archiveClosureFilter}
           ORDER BY sessions.updated_at DESC, sessions.id DESC`
        )
        .bind(...params, limit + 1, limit)
        .all<TreeSessionRow>();

      const rows = result.results ?? [];
      const baseRows = rows.filter((row) => row.is_base === 1);
      const hasMore = (rows[0]?.candidate_count ?? 0) > limit;
      const lastBaseRow = baseRows.at(-1);
      const sessions = await this.decorateEntries(rows.map(toEntry), viewerUserId);

      return {
        sessions,
        hasMore,
        nextCursor:
          hasMore && lastBaseRow
            ? { updatedAt: epochMs(lastBaseRow.updated_at), id: lastBaseRow.id }
            : null,
      };
    }

    // Get paginated results
    const result = await this.db
      .prepare(
        `${archivedSubtreesCte} SELECT * FROM sessions ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`
      )
      .bind(...params, limit + 1, offset)
      .all<SessionRow>();

    const rows = result.results || [];
    const sessions = await this.decorateEntries(rows.slice(0, limit).map(toEntry), viewerUserId);

    return {
      sessions,
      hasMore: rows.length > limit,
    };
  }

  /**
   * Attach repository lists and PR status summaries to the paged
   * entries. The two lookups are independent — each is one grouped query
   * keyed by the same session ids — so they run in parallel and merge onto
   * the entries in a single pass. Sessions without rows are returned without
   * the field: consumers fall back to the scalar repo columns, and PR state
   * never influences session ordering (this only decorates paged rows).
   */
  private async decorateEntries(
    sessions: SessionEntry[],
    viewerUserId?: string
  ): Promise<SessionEntry[]> {
    if (sessions.length === 0) return sessions;
    const sessionIds = sessions.map((session) => session.id);

    const [repositoriesBySession, summariesBySession, unreadBySession] = await Promise.all([
      this.repositoriesForSessions(sessionIds),
      new SessionPullRequestStore(this.db).summariesForSessions(sessionIds),
      viewerUserId
        ? this.unreadForSessions(sessionIds, viewerUserId)
        : Promise.resolve(new Map<string, boolean>()),
    ]);

    return sessions.map((session) => {
      const repositories = repositoriesBySession.get(session.id);
      const pullRequestSummary = summariesBySession.get(session.id);
      return {
        ...session,
        ...(repositories ? { repositories } : {}),
        ...(pullRequestSummary ? { pullRequestSummary } : {}),
        ...(viewerUserId ? { unread: unreadBySession.get(session.id) ?? false } : {}),
      };
    });
  }

  private async unreadForSessions(
    sessionIds: readonly string[],
    userId: string
  ): Promise<Map<string, boolean>> {
    const placeholders = sessionIds.map(() => "?").join(", ");
    const result = await this.db
      .prepare(
        `SELECT sessions.id,
           CASE WHEN read_state.manually_unread = 1 OR (
             sessions.latest_output_message_id IS NOT NULL AND (
               read_state.read_output_message_id IS NULL
               OR read_state.read_output_message_id != sessions.latest_output_message_id
             )
           ) THEN 1 ELSE 0 END AS unread
         FROM sessions
         LEFT JOIN session_read_states AS read_state
           ON read_state.session_id = sessions.id AND read_state.user_id = ?
         WHERE sessions.id IN (${placeholders})`
      )
      .bind(userId, ...sessionIds)
      .all<{ id: string; unread: number }>();

    return new Map((result.results ?? []).map((row) => [row.id, row.unread === 1]));
  }

  /** Repository lists for the given sessions, in one query. */
  private async repositoriesForSessions(
    sessionIds: readonly string[]
  ): Promise<Map<string, SessionIndexRepository[]>> {
    const placeholders = sessionIds.map(() => "?").join(", ");
    const result = await this.db
      .prepare(
        `SELECT * FROM session_repositories
         WHERE session_id IN (${placeholders})
         ORDER BY session_id, position`
      )
      .bind(...sessionIds)
      .all<SessionRepositoryRow>();

    const bySession = new Map<string, SessionIndexRepository[]>();
    for (const row of result.results || []) {
      const list = bySession.get(row.session_id) ?? [];
      list.push({
        repoOwner: row.repo_owner,
        repoName: row.repo_name,
        repoId: row.repo_id,
        baseBranch: row.base_branch,
      });
      bySession.set(row.session_id, list);
    }
    return bySession;
  }

  async updateTitle(id: string, title: string): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
      .bind(title, Date.now(), id)
      .run();

    return (result.meta.changes ?? 0) > 0;
  }

  async updateTitleIfNewer(id: string, title: string, updatedAt: number): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ? AND updated_at <= ?")
      .bind(title, updatedAt, id, updatedAt)
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  async updateStatus(id: string, status: SessionStatus, updatedAt = Date.now()): Promise<boolean> {
    // Protect against out-of-order async writes by only applying monotonic updated_at values.
    const result = await this.db
      .prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ? AND updated_at <= ?")
      .bind(status, updatedAt, id, updatedAt)
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  async recordOutput(id: string, messageId: string, completedAt: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE sessions
         SET latest_output_message_id = ?, latest_output_at = ?
         WHERE id = ? AND (latest_output_at IS NULL OR latest_output_at <= ?)`
      )
      .bind(messageId, completedAt, id, completedAt)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async updateReadState(
    sessionId: string,
    userId: string,
    update: SessionReadUpdate
  ): Promise<boolean | null> {
    const session = await this.db
      .prepare("SELECT latest_output_message_id FROM sessions WHERE id = ?")
      .bind(sessionId)
      .first<{ latest_output_message_id: string | null }>();
    if (!session) return null;

    const now = Date.now();
    if (update.action === "mark_unread") {
      await this.db
        .prepare(
          `INSERT INTO session_read_states
             (user_id, session_id, read_output_message_id, manually_unread, updated_at)
           VALUES (?, ?, NULL, 1, ?)
           ON CONFLICT(user_id, session_id) DO UPDATE SET
             manually_unread = 1,
             updated_at = excluded.updated_at`
        )
        .bind(userId, sessionId, now)
        .run();
      return true;
    }

    if (update.action === "viewed") {
      await this.db
        .prepare(
          `INSERT INTO session_read_states
             (user_id, session_id, read_output_message_id, manually_unread, updated_at)
           VALUES (?, ?, ?, 0, ?)
           ON CONFLICT(user_id, session_id) DO UPDATE SET
              read_output_message_id = CASE
                WHEN session_read_states.manually_unread = 0
                  AND (
                    session_read_states.read_output_message_id IS NULL
                    OR excluded.read_output_message_id = ?
                  )
                THEN excluded.read_output_message_id
                ELSE session_read_states.read_output_message_id
              END,
              updated_at = excluded.updated_at`
        )
        .bind(userId, sessionId, update.messageId, now, session.latest_output_message_id)
        .run();
    } else {
      await this.db
        .prepare(
          `INSERT INTO session_read_states
             (user_id, session_id, read_output_message_id, manually_unread, updated_at)
           VALUES (?, ?, ?, 0, ?)
           ON CONFLICT(user_id, session_id) DO UPDATE SET
             read_output_message_id = excluded.read_output_message_id,
             manually_unread = 0,
             updated_at = excluded.updated_at`
        )
        .bind(userId, sessionId, session.latest_output_message_id, now)
        .run();
    }

    const unread = await this.unreadForSessions([sessionId], userId);
    return unread.get(sessionId) ?? false;
  }

  async updateMetrics(
    id: string,
    metrics: {
      totalCost: number;
      activeDurationMs: number;
      messageCount: number;
      prCount: number;
    }
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE sessions SET total_cost = MAX(total_cost, ?), active_duration_ms = ?, message_count = ?, pr_count = ?
         WHERE id = ?`
      )
      .bind(metrics.totalCost, metrics.activeDurationMs, metrics.messageCount, metrics.prCount, id)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async touchUpdatedAt(id: string): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .bind(Date.now(), id)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async delete(id: string): Promise<boolean> {
    // Member rows are removed explicitly for clarity; the FK's ON DELETE
    // CASCADE also covers callers that delete the session row directly.
    const [, result] = await this.db.batch([
      this.db.prepare("DELETE FROM session_repositories WHERE session_id = ?").bind(id),
      this.db.prepare("DELETE FROM sessions WHERE id = ?").bind(id),
    ]);

    return (result.meta?.changes ?? 0) > 0;
  }

  /** List children of a parent session, newest first. */
  async listByParent(parentSessionId: string): Promise<SessionEntry[]> {
    const result = await this.db
      .prepare(`SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY created_at DESC`)
      .bind(parentSessionId)
      .all<SessionRow>();
    return (result.results || []).map(toEntry);
  }

  async hasUnfinishedDescendants(parentSessionId: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `WITH RECURSIVE descendants(id, status, path) AS (
           SELECT id, status,
             '/' || hex(CAST(? AS BLOB)) || '/' || hex(CAST(id AS BLOB)) || '/'
           FROM sessions WHERE parent_session_id = ?
           UNION ALL
           SELECT sessions.id, sessions.status,
             descendants.path || hex(CAST(sessions.id AS BLOB)) || '/'
           FROM sessions
           JOIN descendants ON sessions.parent_session_id = descendants.id
           WHERE instr(
             descendants.path,
             '/' || hex(CAST(sessions.id AS BLOB)) || '/'
           ) = 0
         )
         SELECT EXISTS(
           SELECT 1 FROM descendants
           WHERE status NOT IN ('completed', 'failed', 'cancelled', 'archived')
         ) AS has_unfinished`
      )
      .bind(parentSessionId, parentSessionId)
      .first<{ has_unfinished: number }>();
    return result?.has_unfinished === 1;
  }

  async archiveDescendants(parentSessionId: string, updatedAt: EpochMs): Promise<void> {
    await this.db
      .prepare(
        `WITH RECURSIVE subtree(id, path) AS (
           SELECT id, '/' || hex(CAST(id AS BLOB)) || '/'
           FROM sessions WHERE id = ?
           UNION ALL
           SELECT sessions.id, subtree.path || hex(CAST(sessions.id AS BLOB)) || '/'
           FROM sessions
           JOIN subtree ON sessions.parent_session_id = subtree.id
           WHERE instr(
             subtree.path,
             '/' || hex(CAST(sessions.id AS BLOB)) || '/'
           ) = 0
         )
         UPDATE sessions
         SET spawn_closed = 1,
             status = CASE
               WHEN id = ? THEN status
               ELSE 'archived'
             END,
             updated_at = CASE
               WHEN id = ? THEN updated_at
               ELSE MAX(updated_at + 1, ?)
             END
         WHERE id IN (SELECT id FROM subtree)`
      )
      .bind(parentSessionId, parentSessionId, parentSessionId, updatedAt)
      .run();
  }

  async restoreArchivedSession(id: string, updatedAt: EpochMs): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE sessions
         SET status = 'active', spawn_closed = 0, updated_at = ?
         WHERE id = ? AND updated_at <= ?`
      )
      .bind(updatedAt, id, updatedAt)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async closeSpawningAndListDescendantIds(parentSessionId: string): Promise<string[]> {
    const closeSpawning = this.db
      .prepare(
        `WITH RECURSIVE subtree(id, path) AS (
           SELECT id, '/' || hex(CAST(id AS BLOB)) || '/'
           FROM sessions WHERE id = ?
           UNION ALL
           SELECT sessions.id, subtree.path || hex(CAST(sessions.id AS BLOB)) || '/'
           FROM sessions
           JOIN subtree ON sessions.parent_session_id = subtree.id
           WHERE instr(
             subtree.path,
             '/' || hex(CAST(sessions.id AS BLOB)) || '/'
           ) = 0
         )
         UPDATE sessions
         SET spawn_closed = 1
         WHERE id IN (SELECT id FROM subtree)`
      )
      .bind(parentSessionId);
    const listDescendants = this.db
      .prepare(
        `WITH RECURSIVE descendants(id, depth, path) AS (
           SELECT id, 1,
             '/' || hex(CAST(? AS BLOB)) || '/' || hex(CAST(id AS BLOB)) || '/'
           FROM sessions WHERE parent_session_id = ?
           UNION ALL
           SELECT sessions.id, descendants.depth + 1,
             descendants.path || hex(CAST(sessions.id AS BLOB)) || '/'
           FROM sessions
           JOIN descendants ON sessions.parent_session_id = descendants.id
           WHERE instr(
             descendants.path,
             '/' || hex(CAST(sessions.id AS BLOB)) || '/'
           ) = 0
         )
         SELECT id FROM descendants ORDER BY depth DESC`
      )
      .bind(parentSessionId, parentSessionId);

    const [, result] = await this.db.batch<{ id: string }>([closeSpawning, listDescendants]);
    return (result.results || []).map(({ id }) => id);
  }

  /** Count active (non-terminal) children for concurrent cap enforcement. */
  async countActiveChildren(parentSessionId: string): Promise<number> {
    const result = await this.db
      .prepare(
        `SELECT COUNT(*) as count FROM sessions
         WHERE parent_session_id = ? AND status NOT IN (${TERMINAL_STATUS_SQL})`
      )
      .bind(parentSessionId)
      .first<{ count: number }>();
    return result?.count ?? 0;
  }

  /** Count total children ever spawned for rate-limit enforcement. */
  async countTotalChildren(parentSessionId: string): Promise<number> {
    const result = await this.db
      .prepare(`SELECT COUNT(*) as count FROM sessions WHERE parent_session_id = ?`)
      .bind(parentSessionId)
      .first<{ count: number }>();
    return result?.count ?? 0;
  }

  /** Validate that childId is a direct child of parentId. */
  async isChildOf(childId: string, parentId: string): Promise<boolean> {
    const result = await this.db
      .prepare(`SELECT 1 FROM sessions WHERE id = ? AND parent_session_id = ?`)
      .bind(childId, parentId)
      .first();
    return result !== null;
  }

  /** Get a session's stored spawn_depth (single read, no chain walking). */
  async getSpawnDepth(sessionId: string): Promise<number> {
    const result = await this.db
      .prepare(`SELECT spawn_depth FROM sessions WHERE id = ?`)
      .bind(sessionId)
      .first<{ spawn_depth: number }>();
    return result?.spawn_depth ?? 0;
  }
}
