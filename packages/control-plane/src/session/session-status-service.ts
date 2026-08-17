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
import type { SessionStatus } from "@open-inspect/shared/types/sessions";
import type { SessionRow } from "./types";
import type { SessionCoreRepository } from "./session-core-repository";
import type { MessageRepository } from "./message-repository";
import type { ArtifactRepository } from "./artifact-repository";
import type { SessionMessenger } from "./messenger";
import type { BackgroundJobDispatcher } from "../platform-ports";
import { getSessionAutoArchiveDelayMs } from "./auto-archive-policy";
import { SandboxProviderError } from "../sandbox/provider";

/** Statuses that indicate a session is finished — metrics are synced to D1 on these transitions. */
const TERMINAL_STATUSES: SessionStatus[] = ["completed", "failed", "cancelled"];
const CHILD_ARCHIVE_ATTEMPTS = 3;
const ARCHIVE_RETRY_DELAY_MS = 5 * 60 * 1000;

export type ArchiveAttemptResult = "archived" | "in_progress" | "failed";
type ArchiveRetryPolicy = "none" | "preserve-request" | "recheck-retention";

export class SessionStatusService {
  constructor(
    private readonly backgroundJobs: BackgroundJobDispatcher,
    private readonly log: Logger,
    private readonly repository: SessionCoreRepository,
    private readonly messageRepository: MessageRepository,
    private readonly artifactRepository: ArtifactRepository,
    private readonly messenger: SessionMessenger,
    private readonly sessionIndex: SessionIndexStore | null,
    private readonly parentSessions: DurableObjectNamespace | null,
    private readonly archiveSandbox: (reason: string) => Promise<void>,
    private readonly scheduleAlarmNoLaterThan: (deadlineAt: number) => Promise<void>
  ) {}

  /**
   * Transition the session to `status`, then project the change to clients,
   * the D1 session index, and the parent session. Returns false when the
   * session is missing or already in `status` (projections are still
   * refreshed in the same-status case).
   */
  async transition(status: SessionStatus): Promise<boolean> {
    if (status === "active" && this.isArchiveInProgress()) return false;
    return this.applyTransition(status, false);
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
    const retryPolicy: ArchiveRetryPolicy = options.retryOnFailure ? "preserve-request" : "none";
    return this.archiveWithRetryPolicy(reason, retryPolicy, options.beforeProviderArchive);
  }

  private async archiveWithRetryPolicy(
    reason: string,
    retryPolicy: ArchiveRetryPolicy,
    beforeProviderArchive?: () => Promise<void>
  ): Promise<ArchiveAttemptResult> {
    const session = this.repository.getSession();
    if (!session) return "failed";

    const claimedAt = Date.now();
    if (!this.repository.claimSessionArchive(session.id, claimedAt)) {
      return "in_progress";
    }

    try {
      await this.scheduleAlarmNoLaterThan(claimedAt + ARCHIVE_RETRY_DELAY_MS);
      await beforeProviderArchive?.();
      await this.archiveSandbox(reason);
      await this.transition("archived");
      return "archived";
    } catch (error) {
      const shouldRetry =
        retryPolicy !== "none" &&
        !(error instanceof SandboxProviderError && error.errorType === "permanent");
      const keepRetryRequest = shouldRetry && retryPolicy === "preserve-request";
      this.repository.clearSessionArchiveClaim(session.id, keepRetryRequest);
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
    restoreArchivedSession: boolean
  ): Promise<boolean> {
    const session = this.repository.getSession();
    if (!session) return false;

    const publicSessionId = this.getPublicSessionId(session);
    if (session.status === status) {
      await this.syncSessionIndexStatus(
        publicSessionId,
        status,
        session.updated_at,
        restoreArchivedSession
      ).catch((error) =>
        this.logSessionIndexStatusSyncError(publicSessionId, status, session.updated_at, error)
      );
      if (status === "archived") {
        await this.archiveDescendantIndexRows(publicSessionId, session.updated_at);
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

    const updatedAt = Math.max(Date.now(), session.updated_at + 1);
    this.repository.updateSessionStatus(session.id, status, updatedAt);
    await this.syncSessionIndexStatus(
      publicSessionId,
      status,
      updatedAt,
      restoreArchivedSession
    ).catch((error) =>
      this.logSessionIndexStatusSyncError(publicSessionId, status, updatedAt, error)
    );

    if (status === "archived") {
      await this.archiveDescendantIndexRows(publicSessionId, updatedAt);
    }

    this.messenger.broadcast({ type: "session_status", status });

    if (TERMINAL_STATUSES.includes(status)) {
      this.syncSessionMetrics(publicSessionId);
      await this.scheduleAutoArchive(session.spawn_source, updatedAt);
    }

    this.notifyParentOfStatusChange(session, publicSessionId, status);

    if (status === "archived") {
      this.cascadeArchiveToChildren(publicSessionId);
    }

    return true;
  }

  private cascadeArchiveToChildren(parentSessionId: string): void {
    if (!this.sessionIndex || !this.parentSessions) return;

    const sessionBinding = this.parentSessions;

    this.backgroundJobs.submit(
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
                return this.scheduleAlarmNoLaterThan(Date.now() + ARCHIVE_RETRY_DELAY_MS);
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
    updatedAt: number
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

    const terminalAt = session.terminal_at ?? session.updated_at;
    const deadlineAt = terminalAt + getSessionAutoArchiveDelayMs(session.spawn_source);
    if (now < deadlineAt) {
      await this.scheduleAlarmNoLaterThan(deadlineAt);
      return;
    }

    await this.archiveWithRetryPolicy("session_auto_archived", "recheck-retention");
  }

  private async scheduleAutoArchive(
    spawnSource: SessionRow["spawn_source"],
    terminalAt: number
  ): Promise<void> {
    const deadlineAt = terminalAt + getSessionAutoArchiveDelayMs(spawnSource);
    await this.scheduleAlarmNoLaterThan(deadlineAt);
  }

  private async syncSessionIndexStatus(
    sessionId: string,
    status: SessionStatus,
    updatedAt: number,
    restoreArchivedSession: boolean
  ): Promise<void> {
    if (!this.sessionIndex) return;
    if (restoreArchivedSession) {
      await this.sessionIndex.restoreArchivedSession(sessionId, updatedAt);
      return;
    }
    await this.sessionIndex.updateStatus(sessionId, status, updatedAt);
  }

  /**
   * Re-project this session's current status onto the index, for callers that
   * already know the two disagree.
   *
   * A swallowed projection failure leaves D1 behind, and the stale row keeps
   * being picked up by anything that scans on status. Unlike `transition`, this
   * claims no new activity: the session did not do anything, its mirror was
   * simply wrong, so `updated_at` is left alone.
   */
  async repairIndexStatus(): Promise<void> {
    const session = this.repository.getSession();
    if (!session || !this.sessionIndex) return;

    const publicSessionId = this.getPublicSessionId(session);
    const repaired = await this.sessionIndex
      .repairStatus(publicSessionId, session.status)
      .catch((error) => {
        this.logSessionIndexStatusSyncError(
          publicSessionId,
          session.status,
          session.updated_at,
          error
        );
        throw error;
      });

    if (repaired && session.status === "active") {
      await this.sessionIndex.finalizeChildAdmission(publicSessionId);
    }
  }

  /**
   * Atomically close the local aggregate before publishing cancellation.
   * The callback must be synchronous: no request may observe cancelled status
   * with unfinished messages, or accept work between those two mutations.
   */
  async cancel(terminalizeUnfinishedMessages: () => void): Promise<boolean> {
    const session = this.repository.getSession();
    if (!session) return false;

    const publicSessionId = this.getPublicSessionId(session);
    const updatedAt = Math.max(Date.now(), session.updated_at + 1);
    this.repository.updateSessionStatus(session.id, "cancelled", updatedAt);
    terminalizeUnfinishedMessages();
    await this.projectTransition(session, publicSessionId, "cancelled", updatedAt);

    return true;
  }

  private async projectTransition(
    session: SessionRow,
    publicSessionId: string,
    status: SessionStatus,
    updatedAt: number
  ): Promise<void> {
    await this.syncSessionIndexStatusAndAdmission(publicSessionId, status, updatedAt).catch(
      (error) => this.logSessionIndexStatusSyncError(publicSessionId, status, updatedAt, error)
    );

    this.messenger.broadcast({ type: "session_status", status });

    if (TERMINAL_STATUSES.includes(status)) {
      this.syncSessionMetrics(publicSessionId);
      this.backgroundJobs.submit(
        this.scheduleAutoArchive(session.spawn_source, updatedAt).catch(() => undefined)
      );
    }

    // Notify parent session (if this is a child) so its UI can refresh
    this.notifyParentOfStatusChange(session, publicSessionId, status);
  }

  /**
   * After an execution finishes, settle the session status: back to active
   * when more prompts are queued, otherwise completed/failed by outcome.
   */
  async reconcileAfterExecution(success: boolean): Promise<void> {
    const pendingOrProcessing = this.messageRepository.getPendingOrProcessingCount();
    const nextStatus: SessionStatus =
      pendingOrProcessing > 0 ? "active" : success ? "completed" : "failed";
    await this.transition(nextStatus);
  }

  async reconcileAfterQueueRemoval(): Promise<void> {
    if (this.messageRepository.getPendingOrProcessingCount() > 0) return;
    const nextStatus = this.getIdleStatusFromTerminalMessages();
    await this.transition(nextStatus);
  }

  async settleFromMessageState(): Promise<SessionStatus> {
    const nextStatus: SessionStatus =
      this.messageRepository.getPendingOrProcessingCount() > 0
        ? "active"
        : this.getIdleStatusFromTerminalMessages();
    await this.transition(nextStatus);
    return nextStatus;
  }

  private getIdleStatusFromTerminalMessages(): SessionStatus {
    const latestMessage = this.messageRepository.getLatestTerminalMessage();
    return latestMessage ? (latestMessage.status === "failed" ? "failed" : "completed") : "created";
  }

  /**
   * Fire-and-forget notification to the parent session so its connected
   * clients can refresh the child-sessions list in real time.
   */
  notifyParentOfChildUpdate(
    session: Pick<SessionRow, "parent_session_id" | "title">,
    childSessionId: string,
    update: { status: SessionStatus; title: string | null }
  ): void {
    const parentId = session.parent_session_id;
    if (!parentId || !this.parentSessions) return;

    const parentDoId = this.parentSessions.idFromName(parentId);
    const parentStub = this.parentSessions.get(parentDoId);

    this.backgroundJobs.submit(
      parentStub
        .fetch(
          new Request(buildSessionInternalUrl(SessionInternalPaths.childSessionUpdate), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              childSessionId,
              status: update.status,
              title: update.title,
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

  private notifyParentOfStatusChange(
    session: Pick<SessionRow, "parent_session_id" | "title">,
    childSessionId: string,
    status: SessionStatus
  ): void {
    this.notifyParentOfChildUpdate(session, childSessionId, {
      status,
      title: session.title,
    });
  }

  private getPublicSessionId(session: SessionRow): string {
    return session.session_name || session.id;
  }

  private async syncSessionIndexStatusAndAdmission(
    sessionId: string,
    status: SessionStatus,
    updatedAt: number
  ): Promise<void> {
    if (!this.sessionIndex) return;
    const projected = await this.sessionIndex.updateStatus(sessionId, status, updatedAt);
    if (projected && status === "active") {
      await this.sessionIndex.finalizeChildAdmission(sessionId);
    }
  }

  private logSessionIndexStatusSyncError(
    sessionId: string,
    status: SessionStatus,
    updatedAt: number,
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

    const messageCount = this.messageRepository.getMessageCount();
    const activeDurationMs = this.messageRepository.getActiveDurationMs();
    const artifacts = this.artifactRepository.listArtifacts();
    const prCount = artifacts.filter((a) => a.type === "pr").length;

    this.backgroundJobs.submit(
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
}
