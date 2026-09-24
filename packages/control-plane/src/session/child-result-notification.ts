import { z } from "zod";
import type { Logger } from "../logger";
import type { AlarmScheduler, BackgroundTasks } from "../platform-ports";
import { SessionInternalPaths } from "./contracts";
import type { SessionRuntimeClient } from "./runtime-client";
import type { SqlStorage } from "./sql-storage";

const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
const RETRY_BATCH_SIZE = 20;

export const childResultPayloadSchema = z.object({
  session: z.object({
    title: z.string(),
    repoOwner: z.string().nullable(),
    repoName: z.string().nullable(),
  }),
  finalResponse: z
    .object({
      messageId: z.string(),
      textContent: z.string(),
      error: z.string().optional(),
      artifacts: z.array(z.object({ type: z.string(), url: z.string() })),
    })
    .nullish(),
});

export type ChildResultPayload = z.infer<typeof childResultPayloadSchema>;

const pendingNotificationSchema = z.object({
  parent_session_id: z.string(),
  child_session_id: z.string(),
  status: z.enum(["completed", "failed", "cancelled"]),
  title: z.string().nullable(),
  status_revision: z.number().int().nonnegative(),
  message_id: z.string().nullable(),
  author_user_id: z.string().nullable(),
  result_payload: z.string(),
  attempts: z.number().int().nonnegative(),
  next_attempt_at: z.number(),
});

export interface ChildResultNotification {
  parentSessionId: string;
  childSessionId: string;
  status: "completed" | "failed" | "cancelled";
  title: string | null;
  statusRevision: number;
  messageId: string | null;
  authorUserId: string | null;
  payload: ChildResultPayload;
}

interface PendingChildResultNotification extends ChildResultNotification {
  attempts: number;
  nextAttemptAt: number;
}

export interface ChildResultNotificationStore {
  add(notification: PendingChildResultNotification): void;
  get(childSessionId: string, statusRevision: number): PendingChildResultNotification | null;
  listDue(now: number, limit: number): PendingChildResultNotification[];
  nextAttemptAt(): number | null;
  recordFailure(
    childSessionId: string,
    statusRevision: number,
    attempts: number,
    nextAttemptAt: number
  ): void;
  remove(childSessionId: string, statusRevision: number): void;
}

export class SqlChildResultNotificationStore implements ChildResultNotificationStore {
  constructor(private readonly sql: SqlStorage) {}

  add(notification: PendingChildResultNotification): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO child_result_notifications
       (parent_session_id, child_session_id, status, title, status_revision, message_id,
         author_user_id, result_payload, attempts, next_attempt_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      notification.parentSessionId,
      notification.childSessionId,
      notification.status,
      notification.title,
      notification.statusRevision,
      notification.messageId,
      notification.authorUserId,
      JSON.stringify(notification.payload),
      notification.attempts,
      notification.nextAttemptAt
    );
  }

  get(childSessionId: string, statusRevision: number): PendingChildResultNotification | null {
    const row = this.sql
      .exec(
        `SELECT parent_session_id, child_session_id, status, title, status_revision, message_id,
                 author_user_id, result_payload, attempts, next_attempt_at
         FROM child_result_notifications
         WHERE child_session_id = ? AND status_revision = ?`,
        childSessionId,
        statusRevision
      )
      .toArray()[0];
    return row === undefined ? null : parsePendingNotification(row);
  }

  listDue(now: number, limit: number): PendingChildResultNotification[] {
    return this.sql
      .exec(
        `SELECT parent_session_id, child_session_id, status, title, status_revision, message_id,
                 author_user_id, result_payload, attempts, next_attempt_at
         FROM child_result_notifications
         WHERE next_attempt_at <= ?
         ORDER BY next_attempt_at, child_session_id, status_revision
         LIMIT ?`,
        now,
        limit
      )
      .toArray()
      .map(parsePendingNotification);
  }

  nextAttemptAt(): number | null {
    const row = this.sql
      .exec("SELECT MIN(next_attempt_at) AS next_attempt_at FROM child_result_notifications")
      .toArray()[0] as { next_attempt_at?: unknown } | undefined;
    return typeof row?.next_attempt_at === "number" ? row.next_attempt_at : null;
  }

  recordFailure(
    childSessionId: string,
    statusRevision: number,
    attempts: number,
    nextAttemptAt: number
  ): void {
    this.sql.exec(
      `UPDATE child_result_notifications
       SET attempts = ?, next_attempt_at = ?
       WHERE child_session_id = ? AND status_revision = ?`,
      attempts,
      nextAttemptAt,
      childSessionId,
      statusRevision
    );
  }

  remove(childSessionId: string, statusRevision: number): void {
    this.sql.exec(
      `DELETE FROM child_result_notifications
       WHERE child_session_id = ? AND status_revision = ?`,
      childSessionId,
      statusRevision
    );
  }
}

export class ChildResultNotifier {
  constructor(
    private readonly store: ChildResultNotificationStore,
    private readonly sessions: SessionRuntimeClient,
    private readonly backgroundTasks: BackgroundTasks,
    private readonly alarmScheduler: AlarmScheduler,
    private readonly log: Logger,
    private readonly now: () => number = Date.now
  ) {}

  enqueue(notification: ChildResultNotification): void {
    this.persist(notification);
    this.kick(notification);
  }

  persist(notification: ChildResultNotification): void {
    this.store.add({ ...notification, attempts: 0, nextAttemptAt: this.now() });
  }

  kick(notification: ChildResultNotification): void {
    this.backgroundTasks.submit(
      () => this.attempt(notification.childSessionId, notification.statusRevision),
      {
        name: "child_result.notify_parent",
        context: {
          child_id: notification.childSessionId,
          status_revision: notification.statusRevision,
        },
      }
    );
  }

  async flushPending(): Promise<void> {
    const pending = this.store.listDue(this.now(), RETRY_BATCH_SIZE);
    for (const notification of pending) {
      await this.attempt(notification.childSessionId, notification.statusRevision);
    }
    await this.rearm();
  }

  async rearm(): Promise<void> {
    const nextAttemptAt = this.store.nextAttemptAt();
    if (nextAttemptAt !== null) await this.arm(nextAttemptAt);
  }

  private async attempt(childSessionId: string, statusRevision: number): Promise<void> {
    const notification = this.store.get(childSessionId, statusRevision);
    if (!notification) return;

    try {
      const response = await this.sessions.fetch(
        notification.parentSessionId,
        SessionInternalPaths.childSessionUpdate,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            childSessionId: notification.childSessionId,
            status: notification.status,
            statusRevision: notification.statusRevision,
            title: notification.title,
            childResult: {
              messageId: notification.messageId,
              authorUserId: notification.authorUserId,
              payload: notification.payload,
            },
          }),
        }
      );
      if (!response.ok) throw new Error(`Parent update failed with status ${response.status}`);
      this.store.remove(childSessionId, statusRevision);
      return;
    } catch (error) {
      const attempts = notification.attempts + 1;
      const nextAttemptAt = this.now() + retryDelayMs(attempts);
      this.store.recordFailure(childSessionId, statusRevision, attempts, nextAttemptAt);
      await this.arm(nextAttemptAt);
      this.log.warn("child_result.parent_notification_retry", {
        child_id: childSessionId,
        status_revision: statusRevision,
        attempts,
        next_attempt_at: nextAttemptAt,
        error,
      });
    }
  }

  private async arm(nextAttemptAt: number): Promise<void> {
    try {
      await this.alarmScheduler.schedule(nextAttemptAt);
    } catch (error) {
      this.log.warn("child_result.parent_notification_retry_arm_failed", {
        next_attempt_at: nextAttemptAt,
        error,
      });
    }
  }
}

function parsePendingNotification(row: unknown): PendingChildResultNotification {
  const parsed = pendingNotificationSchema.safeParse(row);
  if (!parsed.success) throw new Error("Malformed pending child result notification row");
  return {
    parentSessionId: parsed.data.parent_session_id,
    childSessionId: parsed.data.child_session_id,
    status: parsed.data.status,
    title: parsed.data.title,
    statusRevision: parsed.data.status_revision,
    messageId: parsed.data.message_id,
    authorUserId: parsed.data.author_user_id,
    payload: childResultPayloadSchema.parse(JSON.parse(parsed.data.result_payload)),
    attempts: parsed.data.attempts,
    nextAttemptAt: parsed.data.next_attempt_at,
  };
}

function retryDelayMs(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 16), RETRY_MAX_MS);
}
