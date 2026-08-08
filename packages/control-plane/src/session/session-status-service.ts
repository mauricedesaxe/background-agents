/**
 * SessionStatusService — owns the session's `status` and its projections.
 *
 * Every status change fans out to three places: the connected clients
 * (broadcast), the D1 session index (status + terminal metrics mirror), and
 * the parent session's Durable Object (child rollup). This service is the
 * single place those projections are kept consistent; every public method is
 * a transition on that one noun.
 */

import { buildSessionInternalUrl, SessionInternalPaths } from "./contracts";
import type { Logger } from "../logger";
import type { SessionIndexStore } from "../db/session-index";
import type { SessionStatus } from "../types";
import type { SessionRow } from "./types";
import type { SessionRepository } from "./repository";
import type { SessionMessenger } from "./messenger";
import { epochMs, nowMs, type EpochMs } from "../time";
import { getSessionAutoArchiveDelayMs } from "./auto-archive-policy";
import { SandboxProviderError } from "../sandbox/provider";

/** Statuses that indicate a session is finished — metrics are synced to D1 on these transitions. */
const TERMINAL_STATUSES: SessionStatus[] = ["completed", "failed", "cancelled"];
const CHILD_ARCHIVE_ATTEMPTS = 3;
const PARENT_NOTIFY_ATTEMPTS = 3;
const ARCHIVE_RETRY_DELAY_MS = 5 * 60 * 1000;
const PENDING_PARENT_NOTIFICATIONS_KEY = "pendingParentNotifications";

interface PendingParentNotification {
  deliveryId: string;
  parentId: string;
  childSessionId: string;
  status: SessionStatus;
  title: string | null;
  childResultMessageId: string | null;
  updatedAt: number;
}

export type ArchiveAttemptResult = "archived" | "in_progress" | "failed";

export class SessionStatusService {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly log: Logger,
    private readonly repository: SessionRepository,
    private readonly messenger: SessionMessenger,
    private readonly sessionIndex: SessionIndexStore | null,
    private readonly sessions: DurableObjectNamespace | null,
    private readonly archiveSandbox: (reason: string) => Promise<void>
  ) {}

  /**
   * Transition the session to `status`, then project the change to clients,
   * the D1 session index, and the parent session. Returns false when the
   * session is missing or already in `status` (projections are still
   * refreshed in the same-status case).
   */
  async transition(
    status: SessionStatus,
    childResultMessageId: string | null = null
  ): Promise<boolean> {
    if (status === "active" && this.isArchiveInProgress()) return false;
    return this.applyTransition(status, false, childResultMessageId);
  }

  async unarchive(): Promise<boolean> {
    if (this.isArchiveInProgress()) return false;
    return this.applyTransition("active", true);
  }

  isArchiveInProgress(): boolean {
    return this.repository.getSession()?.archive_claimed_at != null;
  }

  async archive(
    reason: string,
    options: {
      retryOnFailure?: boolean;
      beforeProviderArchive?: () => Promise<void>;
    } = {}
  ): Promise<ArchiveAttemptResult> {
    const session = this.repository.getSession();
    if (!session) return "failed";

    const claimedAt = nowMs();
    const retryOnFailure = options.retryOnFailure ?? false;
    if (!this.repository.claimSessionArchive(session.id, claimedAt)) {
      return "in_progress";
    }

    try {
      await this.scheduleAlarmNoLaterThan(claimedAt + ARCHIVE_RETRY_DELAY_MS);
      await options.beforeProviderArchive?.();
      await this.archiveSandbox(reason);
      await this.transition("archived");
      return "archived";
    } catch (error) {
      const shouldRetry =
        retryOnFailure &&
        !(error instanceof SandboxProviderError && error.errorType === "permanent");
      this.repository.clearSessionArchiveClaim(session.id, shouldRetry);
      this.log.error("session_archive.failed", {
        session_id: this.getPublicSessionId(session),
        reason,
        error,
      });
      if (shouldRetry) {
        await this.scheduleAlarmNoLaterThan(claimedAt + ARCHIVE_RETRY_DELAY_MS);
      }
      return "failed";
    }
  }

  private async applyTransition(
    status: SessionStatus,
    restoreArchivedSession: boolean,
    childResultMessageId: string | null = null
  ) {
    const session = this.repository.getSession();
    if (!session) return false;

    const publicSessionId = this.getPublicSessionId(session);
    const deferTerminalIndex =
      session.parent_session_id != null && TERMINAL_STATUSES.includes(status);
    if (session.status === status) {
      const updatedAt = epochMs(session.updated_at);
      if (deferTerminalIndex) {
        await this.notifyParentOfStatusChange(
          session,
          publicSessionId,
          status,
          childResultMessageId,
          updatedAt
        );
      } else {
        await this.syncSessionIndexStatus(
          publicSessionId,
          status,
          updatedAt,
          restoreArchivedSession
        ).catch((error) =>
          this.logSessionIndexStatusSyncError(publicSessionId, status, updatedAt, error)
        );
      }
      if (status === "archived") {
        await this.archiveDescendantIndexRows(publicSessionId, updatedAt);
        this.cascadeArchiveToChildren(publicSessionId);
      }
      if (TERMINAL_STATUSES.includes(status)) {
        this.syncSessionMetrics(publicSessionId);
        await this.scheduleAutoArchive(
          session.spawn_source,
          session.terminal_at ?? session.updated_at
        );
      }
      return false;
    }

    const updatedAt = epochMs(Math.max(nowMs(), session.updated_at + 1));
    this.repository.updateSessionStatus(session.id, status, updatedAt);
    if (!deferTerminalIndex) {
      await this.syncSessionIndexStatus(
        publicSessionId,
        status,
        updatedAt,
        restoreArchivedSession
      ).catch((error) =>
        this.logSessionIndexStatusSyncError(publicSessionId, status, updatedAt, error)
      );
    }

    if (status === "archived") {
      await this.archiveDescendantIndexRows(publicSessionId, updatedAt);
    }

    this.messenger.broadcast({ type: "session_status", status });

    if (TERMINAL_STATUSES.includes(status)) {
      this.syncSessionMetrics(publicSessionId);
      await this.scheduleAutoArchive(session.spawn_source, updatedAt);
    }

    // Notify parent session (if this is a child) so its UI can refresh
    if (deferTerminalIndex) {
      await this.notifyParentOfStatusChange(
        session,
        publicSessionId,
        status,
        childResultMessageId,
        updatedAt
      );
    } else {
      this.notifyParentOfChildUpdate(session, publicSessionId, {
        status,
        title: session.title,
      });
    }

    if (status === "archived") {
      this.cascadeArchiveToChildren(publicSessionId);
    }

    return true;
  }

  /**
   * Reconcile each child's Durable Object after the index subtree has already
   * been archived. Every child is called because its local state and sandbox
   * may still be active even though its index row is now archived.
   */
  private cascadeArchiveToChildren(parentSessionId: string): void {
    if (!this.sessionIndex || !this.sessions) return;

    const sessionBinding = this.sessions;

    this.ctx.waitUntil(
      this.sessionIndex
        .listByParent(parentSessionId)
        .then((children) =>
          Promise.all(
            children.map((child) => {
              const childDoId = sessionBinding.idFromName(child.id);
              return this.archiveChildWithRetry(sessionBinding.get(childDoId)).catch((error) => {
                this.log.error("cascade_archive.child_failed", {
                  parent_id: parentSessionId,
                  child_id: child.id,
                  error,
                });
                return this.scheduleAlarmNoLaterThan(nowMs() + ARCHIVE_RETRY_DELAY_MS);
              });
            })
          )
        )
        .then(() => undefined)
        .catch((error) => {
          this.log.error("cascade_archive.failed", {
            parent_id: parentSessionId,
            error,
          });
        })
    );
  }

  private async archiveDescendantIndexRows(
    parentSessionId: string,
    updatedAt: EpochMs
  ): Promise<void> {
    if (!this.sessionIndex) return;

    await this.sessionIndex.archiveDescendants(parentSessionId, updatedAt).catch((error) => {
      this.log.error("cascade_archive.index_failed", {
        parent_id: parentSessionId,
        error,
      });
    });
  }

  private async archiveChildWithRetry(child: DurableObjectStub): Promise<void> {
    for (let attempt = 1; attempt <= CHILD_ARCHIVE_ATTEMPTS; attempt += 1) {
      try {
        const response = await child.fetch(
          new Request(buildSessionInternalUrl(SessionInternalPaths.archiveCascade), {
            method: "POST",
          })
        );
        if (response.ok) return;
        if (attempt === CHILD_ARCHIVE_ATTEMPTS) {
          throw new Error(`Child archive returned HTTP ${response.status}`);
        }
      } catch (error) {
        if (attempt === CHILD_ARCHIVE_ATTEMPTS) throw error;
      }
    }
  }

  /**
   * After an execution finishes, settle the session status: back to active
   * when more prompts are queued, otherwise completed/failed by outcome.
   */
  async reconcileAfterExecution(success: boolean, messageId: string | null = null): Promise<void> {
    const pendingOrProcessing = this.repository.getPendingOrProcessingCount();
    const nextStatus: SessionStatus =
      pendingOrProcessing > 0 ? "active" : success ? "completed" : "failed";
    await this.transition(nextStatus, messageId);
  }

  async recordCompletedOutput(messageId: string, completedAt: number): Promise<void> {
    if (!this.sessionIndex) return;
    const session = this.repository.getSession();
    if (!session) return;

    const sessionId = this.getPublicSessionId(session);
    await this.sessionIndex.recordOutput(sessionId, messageId, completedAt).catch((error) => {
      this.log.error("session_index.record_output.background_error", {
        session_id: sessionId,
        message_id: messageId,
        error,
      });
    });
  }

  async retryPendingParentNotifications(): Promise<void> {
    const pending = await this.getPendingParentNotifications();
    for (const notification of pending) {
      await this.deliverParentNotification(notification);
    }
  }

  /** Archive alarm re-reads `terminal_at` on each fire; extending it is enough. */
  recordTerminalActivity(now: number): void {
    const session = this.repository.getSession();
    if (!session) return;
    this.repository.extendTerminalActivity(session.id, now);
  }

  async handleAutoArchiveAlarm(now: number): Promise<void> {
    const session = this.repository.getSession();
    if (!session) return;

    if (session.status === "archived") {
      this.cascadeArchiveToChildren(this.getPublicSessionId(session));
      return;
    }

    if (session.archive_requested_at != null) {
      if (!TERMINAL_STATUSES.includes(session.status)) {
        this.repository.clearSessionArchiveClaim(session.id, false);
        return;
      }
      if (
        session.archive_claimed_at != null &&
        now < session.archive_claimed_at + ARCHIVE_RETRY_DELAY_MS
      ) {
        await this.scheduleAlarmNoLaterThan(session.archive_claimed_at + ARCHIVE_RETRY_DELAY_MS);
        return;
      }
      if (session.archive_claimed_at != null) {
        this.repository.clearSessionArchiveClaim(session.id, true);
      }
      await this.archive("session_archive_retried", { retryOnFailure: true });
      return;
    }

    if (!TERMINAL_STATUSES.includes(session.status)) return;

    if (await this.hasUnfinishedChildren(this.getPublicSessionId(session))) {
      await this.scheduleAlarmNoLaterThan(now + ARCHIVE_RETRY_DELAY_MS);
      return;
    }

    const latestSession = this.repository.getSession();
    if (!latestSession || !TERMINAL_STATUSES.includes(latestSession.status)) return;
    const terminalAt = latestSession.terminal_at ?? latestSession.updated_at;
    const deadlineAt = terminalAt + getSessionAutoArchiveDelayMs(latestSession.spawn_source);
    if (now < deadlineAt) {
      await this.scheduleAlarmNoLaterThan(deadlineAt);
      return;
    }

    await this.archive("session_auto_archived", { retryOnFailure: true });
  }

  /**
   * Fire-and-forget notification to the parent session so its connected
   * clients can refresh the child-sessions list in real time.
   */
  notifyParentOfChildUpdate(
    session: Pick<SessionRow, "parent_session_id" | "title">,
    childSessionId: string,
    update: { status: SessionStatus; title: string | null; deliverResult?: boolean }
  ): void {
    const parentId = session.parent_session_id;
    if (!parentId || !this.sessions) return;

    const parentDoId = this.sessions.idFromName(parentId);
    const parentStub = this.sessions.get(parentDoId);

    this.ctx.waitUntil(
      parentStub
        .fetch(
          new Request(buildSessionInternalUrl(SessionInternalPaths.childSessionUpdate), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              childSessionId,
              status: update.status,
              title: update.title,
              deliverResult: update.deliverResult === true,
            }),
          })
        )
        .catch((error) => {
          this.log.error("notify_parent.failed", {
            parent_id: parentId,
            child_id: childSessionId,
            status: update.status,
            error,
          });
        })
    );
  }

  private async notifyParentOfStatusChange(
    session: Pick<SessionRow, "parent_session_id" | "title">,
    childSessionId: string,
    status: SessionStatus,
    childResultMessageId: string | null,
    updatedAt: number
  ): Promise<void> {
    const parentId = session.parent_session_id;
    if (!parentId || !this.sessions) return;

    const notification: PendingParentNotification = {
      deliveryId: childResultMessageId ?? `${childSessionId}:${status}`,
      parentId,
      childSessionId,
      status,
      title: session.title,
      childResultMessageId,
      updatedAt,
    };
    const pending = await this.getPendingParentNotifications();
    const withoutCurrent = pending.filter(
      (candidate) => candidate.deliveryId !== notification.deliveryId
    );
    await this.ctx.storage.put(PENDING_PARENT_NOTIFICATIONS_KEY, [...withoutCurrent, notification]);
    await this.deliverParentNotification(notification);
  }

  private async deliverParentNotification(notification: PendingParentNotification): Promise<void> {
    if (!this.sessions) return;

    const parentStub = this.sessions.get(this.sessions.idFromName(notification.parentId));
    for (let attempt = 1; attempt <= PARENT_NOTIFY_ATTEMPTS; attempt += 1) {
      try {
        const response = await parentStub.fetch(
          new Request(buildSessionInternalUrl(SessionInternalPaths.childSessionUpdate), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              childSessionId: notification.childSessionId,
              status: notification.status,
              title: notification.title,
              deliverResult: true,
              childResultMessageId: notification.childResultMessageId,
            }),
          })
        );
        if (response.ok) {
          if (this.sessionIndex) {
            await this.sessionIndex.updateStatus(
              notification.childSessionId,
              notification.status,
              epochMs(notification.updatedAt)
            );
          }
          await this.removePendingParentNotification(notification.deliveryId);
          return;
        }
        if (attempt === PARENT_NOTIFY_ATTEMPTS) {
          throw new Error(`Parent notification returned HTTP ${response.status}`);
        }
      } catch (error) {
        if (attempt < PARENT_NOTIFY_ATTEMPTS) continue;
        this.log.error("notify_parent.failed", {
          parent_id: notification.parentId,
          child_id: notification.childSessionId,
          status: notification.status,
          error,
        });
      }
    }
    await this.scheduleAlarmNoLaterThan(nowMs() + ARCHIVE_RETRY_DELAY_MS);
  }

  private async getPendingParentNotifications(): Promise<PendingParentNotification[]> {
    return (
      (await this.ctx.storage.get<PendingParentNotification[]>(PENDING_PARENT_NOTIFICATIONS_KEY)) ??
      []
    );
  }

  private async removePendingParentNotification(deliveryId: string): Promise<void> {
    const remaining = (await this.getPendingParentNotifications()).filter(
      (notification) => notification.deliveryId !== deliveryId
    );
    if (remaining.length > 0) {
      await this.ctx.storage.put(PENDING_PARENT_NOTIFICATIONS_KEY, remaining);
    } else {
      await this.ctx.storage.delete(PENDING_PARENT_NOTIFICATIONS_KEY);
    }
  }

  private async hasUnfinishedChildren(parentSessionId: string): Promise<boolean> {
    if (!this.sessionIndex) return false;
    try {
      return await this.sessionIndex.hasUnfinishedDescendants(parentSessionId);
    } catch (error) {
      this.log.error("session_archive.children_lookup_failed", {
        parent_id: parentSessionId,
        error,
      });
      return true;
    }
  }

  private getPublicSessionId(session: SessionRow): string {
    return session.session_name || session.id || this.ctx.id.toString();
  }

  private async syncSessionIndexStatus(
    sessionId: string,
    status: SessionStatus,
    updatedAt: EpochMs,
    restoreArchivedSession: boolean
  ): Promise<void> {
    if (!this.sessionIndex) return;
    if (restoreArchivedSession) {
      await this.sessionIndex.restoreArchivedSession(sessionId, updatedAt);
      return;
    }
    await this.sessionIndex.updateStatus(sessionId, status, updatedAt);
  }

  private logSessionIndexStatusSyncError(
    sessionId: string,
    status: SessionStatus,
    updatedAt: EpochMs,
    error: unknown
  ): void {
    this.log.error("session_index.update_status.background_error", {
      session_id: sessionId,
      status,
      updated_at: updatedAt,
      error,
    });
  }

  private syncSessionMetrics(sessionId: string): void {
    if (!this.sessionIndex) return;

    const session = this.repository.getSession();
    if (!session) return;

    const messageCount = this.repository.getMessageCount();
    const activeDurationMs = this.repository.getActiveDurationMs();
    const artifacts = this.repository.listArtifacts();
    const prCount = artifacts.filter((a) => a.type === "pr").length;

    this.ctx.waitUntil(
      this.sessionIndex
        .updateMetrics(sessionId, {
          totalCost: session.total_cost ?? 0,
          activeDurationMs,
          messageCount,
          prCount,
        })
        .catch((error) => {
          this.log.error("session_index.update_metrics.background_error", {
            session_id: sessionId,
            error,
          });
        })
    );
  }

  private async scheduleAutoArchive(
    spawnSource: SessionRow["spawn_source"],
    terminalAt: number
  ): Promise<void> {
    const deadlineAt = terminalAt + getSessionAutoArchiveDelayMs(spawnSource);
    await this.scheduleAlarmNoLaterThan(deadlineAt);
  }

  private async scheduleAlarmNoLaterThan(deadlineAt: number): Promise<void> {
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (!currentAlarm || deadlineAt < currentAlarm) {
      await this.ctx.storage.setAlarm(deadlineAt);
    }
  }
}
