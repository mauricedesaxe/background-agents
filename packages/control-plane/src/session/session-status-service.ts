/**
 * SessionStatusService — owns the session's `status` and its projections.
 *
 * Every status change fans out to three places: the connected clients
 * (broadcast), the D1 session index (status + terminal metrics mirror), and
 * the parent session's Durable Object (child rollup). This service is the
 * single place those projections are kept consistent; every public method is
 * a transition on that one noun.
 */

import { SessionInternalPaths } from "./contracts";
import type { SessionRuntimeClient } from "./runtime-client";
import type {
  ChildResultNotifier,
  ChildResultNotification,
  ChildResultPayload,
} from "./child-result-notification";
import type { Logger } from "../logger";
import type { SessionIndexStore } from "../db/session-index";
import type { SessionStatusProjectionStore } from "../db/session-status-projection-store";
import type { SessionStatus } from "@open-inspect/shared/types/sessions";
import type { SessionRow } from "./types";
import type { SessionCoreRepository } from "./session-core-repository";
import type { MessageRepository } from "./message-repository";
import type { ArtifactRepository } from "./artifact-repository";
import type { SessionMessenger } from "./messenger";
import type { BackgroundTasks } from "../platform-ports";
import { isSessionPromptable, isTurnSettled } from "@open-inspect/shared/types/session-activity";

/** The index projections this service keeps consistent with the session row. */
type SessionIndexProjections = Pick<SessionIndexStore, "finalizeChildAdmission" | "updateMetrics">;

interface ChildResultUpdate {
  messageId: string | null;
}

interface ChildResultSnapshot {
  authorUserId: string | null;
  payload: ChildResultPayload;
}

export interface PersistedSessionStatusTransition {
  session: SessionRow;
  publicSessionId: string;
  status: SessionStatus;
  updatedAt: number;
  revision: number;
  childResult?: ChildResultUpdate;
  notification: ChildResultNotification | null;
}

function isChildResultStatus(
  status: SessionStatus
): status is "completed" | "failed" | "cancelled" {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export class SessionStatusService {
  constructor(
    private readonly backgroundTasks: BackgroundTasks,
    private readonly log: Logger,
    private readonly repository: SessionCoreRepository,
    private readonly messageRepository: MessageRepository,
    private readonly artifactRepository: ArtifactRepository,
    private readonly messenger: SessionMessenger,
    private readonly sessionIndex: SessionIndexProjections,
    private readonly statusProjection: Pick<SessionStatusProjectionStore, "project">,
    /** Reaches the parent session's runtime for the child rollup. */
    private readonly sessions: SessionRuntimeClient,
    private readonly childResultNotifier: Pick<ChildResultNotifier, "persist" | "kick">,
    private readonly buildChildResultSnapshot: (messageId: string | null) => ChildResultSnapshot,
    private readonly transactionSync: <T>(closure: () => T) => T
  ) {}

  /**
   * Transition the session to `status`, then project the change to clients,
   * the D1 session index, and the parent session. Returns false when the
   * session is missing or already in `status` (projections are still
   * refreshed in the same-status case).
   */
  async transition(status: SessionStatus): Promise<boolean> {
    return this.transitionInternal(status);
  }

  private async transitionInternal(
    status: SessionStatus,
    childResult?: { messageId: string | null }
  ): Promise<boolean> {
    const session = this.repository.getSession();
    if (!session) return false;

    const publicSessionId = this.getPublicSessionId(session);
    if (session.status === status) {
      await this.syncSessionIndexStatusAndAdmission(
        publicSessionId,
        status,
        session.updated_at,
        session.status_revision
      ).catch((error) =>
        this.logSessionIndexStatusSyncError(publicSessionId, status, session.updated_at, error)
      );
      if (isTurnSettled(status)) {
        this.syncSessionMetrics(publicSessionId);
      }
      return false;
    }

    const transition = this.transactionSync(() => this.persistTransition(status, childResult));
    if (!transition) return false;
    await this.publishPersistedTransition(transition);

    return true;
  }

  /** Persist the status/outbox half while the caller still owns the message transaction. */
  persistAfterExecution(
    success: boolean,
    messageId: string
  ): PersistedSessionStatusTransition | null {
    if (this.isSessionClosed()) return null;
    if (this.messageRepository.getPendingOrProcessingCount() > 0) {
      return this.persistTransition("active");
    }
    return this.persistTransition(success ? "completed" : "failed", { messageId });
  }

  /** Publish only after the transaction containing persistAfterExecution commits. */
  async publishPersistedTransition(
    transition: PersistedSessionStatusTransition | null
  ): Promise<void> {
    if (!transition) return;
    if (transition.notification) this.childResultNotifier.kick(transition.notification);
    await this.projectTransition(
      transition.session,
      transition.publicSessionId,
      transition.status,
      transition.updatedAt,
      transition.revision,
      transition.childResult
    );
  }

  private persistTransition(
    status: SessionStatus,
    childResult?: ChildResultUpdate
  ): PersistedSessionStatusTransition | null {
    const session = this.repository.getSession();
    if (!session || session.status === status) return null;
    const publicSessionId = this.getPublicSessionId(session);
    const updatedAt = Math.max(Date.now(), session.updated_at + 1);
    const revision = session.status_revision + 1;
    this.repository.updateSessionStatus(session.id, status, updatedAt);
    const notification = this.toChildResultNotification(
      session,
      publicSessionId,
      status,
      revision,
      childResult
    );
    if (notification) this.childResultNotifier.persist(notification);
    return {
      session,
      publicSessionId,
      status,
      updatedAt,
      revision,
      ...(childResult ? { childResult } : {}),
      notification,
    };
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
    if (!session) return;

    const publicSessionId = this.getPublicSessionId(session);
    const repaired = await this.statusProjection
      .project(publicSessionId, session.status, session.status_revision, session.updated_at)
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
   * Confirm the current lifecycle generation reached the index. The same
   * revision-fenced write handles transitions, repair, and idempotent retries.
   */
  async confirmIndexStatus(expectedStatus: SessionStatus): Promise<void> {
    const session = this.repository.getSession();
    if (!session || session.status !== expectedStatus) throw new Error("Status superseded");
    const publicSessionId = this.getPublicSessionId(session);
    try {
      const projected = await this.statusProjection.project(
        publicSessionId,
        session.status,
        session.status_revision,
        session.updated_at
      );
      const current = this.repository.getSession();
      if (
        !current ||
        current.status !== expectedStatus ||
        current.status_revision !== session.status_revision
      ) {
        throw new Error("Status superseded");
      }
      if (!projected) throw new Error("Session index missing or superseded");
    } catch (error) {
      this.logSessionIndexStatusSyncError(
        publicSessionId,
        expectedStatus,
        session.updated_at,
        error
      );
      throw error;
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
    const processingMessage = this.messageRepository.getProcessingMessage();
    const childResult = { messageId: processingMessage?.id ?? null };
    let notification: ChildResultNotification | null = null;
    this.transactionSync(() => {
      this.repository.updateSessionStatus(session.id, "cancelled", updatedAt);
      terminalizeUnfinishedMessages();
      notification = this.toChildResultNotification(
        session,
        publicSessionId,
        "cancelled",
        session.status_revision + 1,
        childResult
      );
      if (notification) this.childResultNotifier.persist(notification);
    });
    if (notification) this.childResultNotifier.kick(notification);
    await this.projectTransition(
      session,
      publicSessionId,
      "cancelled",
      updatedAt,
      session.status_revision + 1,
      childResult
    );

    return true;
  }

  private async projectTransition(
    session: SessionRow,
    publicSessionId: string,
    status: SessionStatus,
    updatedAt: number,
    revision: number,
    childResult?: { messageId: string | null }
  ): Promise<void> {
    await this.syncSessionIndexStatusAndAdmission(
      publicSessionId,
      status,
      updatedAt,
      revision
    ).catch((error) =>
      this.logSessionIndexStatusSyncError(publicSessionId, status, updatedAt, error)
    );

    this.messenger.broadcast({ type: "session_status", status });

    if (isTurnSettled(status)) {
      this.syncSessionMetrics(publicSessionId);
    }

    if (!childResult) {
      this.notifyParentOfStatusChange(session, publicSessionId, status, revision);
    }
  }

  private toChildResultNotification(
    session: SessionRow,
    childSessionId: string,
    status: SessionStatus,
    statusRevision: number,
    childResult: { messageId: string | null } | undefined
  ): ChildResultNotification | null {
    if (!childResult || !session.parent_session_id) return null;
    if (!isChildResultStatus(status)) {
      throw new Error(`Child result cannot accompany ${status} status`);
    }
    const snapshot = this.buildChildResultSnapshot(childResult.messageId);
    return {
      parentSessionId: session.parent_session_id,
      childSessionId,
      status,
      title: session.title,
      statusRevision,
      messageId: childResult.messageId,
      authorUserId: snapshot.authorUserId,
      payload: snapshot.payload,
    };
  }

  /**
   * After an execution finishes, settle the session status: back to active
   * when more prompts are queued, otherwise completed/failed by outcome.
   * Leaves a session that was cancelled or archived meanwhile as it is.
   */
  async reconcileAfterExecution(success: boolean, messageId?: string): Promise<void> {
    const terminalMessageId = messageId ?? this.messageRepository.getLatestTerminalMessage()?.id;
    if (!terminalMessageId) {
      if (this.isSessionClosed()) return;
      if (this.messageRepository.getPendingOrProcessingCount() > 0) {
        await this.transition("active");
        return;
      }
      await this.transition(success ? "completed" : "failed");
      return;
    }
    const transition = this.transactionSync(() =>
      this.persistAfterExecution(success, terminalMessageId)
    );
    await this.publishPersistedTransition(transition);
  }

  /** Leaves a session that was cancelled or archived meanwhile as it is. */
  async reconcileAfterQueueRemoval(): Promise<void> {
    if (this.isSessionClosed()) return;
    if (this.messageRepository.getPendingOrProcessingCount() > 0) return;
    const nextStatus = this.getIdleStatusFromTerminalMessages();
    const terminalMessage = this.messageRepository.getLatestTerminalMessage();
    await this.transitionInternal(
      nextStatus,
      terminalMessage ? { messageId: terminalMessage.id } : undefined
    );
  }

  /**
   * Re-derive status from persisted messages after an external lifecycle
   * boundary, without overriding a user-selected terminal status.
   */
  async reconcileFromMessageState(): Promise<void> {
    if (this.isSessionClosed()) return;
    if (this.messageRepository.getPendingOrProcessingCount() > 0) {
      await this.transition("active");
      return;
    }
    const terminalMessage = this.messageRepository.getLatestTerminalMessage();
    const nextStatus: SessionStatus = terminalMessage
      ? terminalMessage.status === "failed"
        ? "failed"
        : "completed"
      : "created";
    await this.transitionInternal(
      nextStatus,
      terminalMessage ? { messageId: terminalMessage.id } : undefined
    );
  }

  /**
   * Whether the session has been cancelled or archived. A reconcile derives
   * the next status from message state, and message state says nothing about
   * a status the user chose; a reconcile that runs after an await (the
   * terminal projection, the stop alarm) must not move such a session, and
   * `transition` writes whatever it is given. Read in the same turn as the
   * transition it guards.
   */
  private isSessionClosed(): boolean {
    const session = this.repository.getSession();
    return session !== null && !isSessionPromptable(session.status);
  }

  async settleFromMessageState(): Promise<SessionStatus> {
    const nextStatus: SessionStatus =
      this.messageRepository.getPendingOrProcessingCount() > 0
        ? "active"
        : this.getIdleStatusFromTerminalMessages();
    await this.transition(nextStatus);
    return nextStatus;
  }

  /**
   * The status an idle session should hold, read off its finished messages.
   *
   * Falling back to `created` sends a session *backwards* into draft, which
   * looks like a bug and is not. It is reachable only when the session has no
   * messages at all -- cancelling the only pending prompt deletes its row --
   * and returning an empty session to draft is what lets the 8-hour
   * abandoned-draft sweep reclaim it. That behaviour was added deliberately
   * after dead sessions accumulated. Do not "fix" it to `completed`.
   */
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
    update: {
      status: SessionStatus;
      statusRevision: number;
      title: string | null;
      childResult?: ChildResultUpdate;
    }
  ): void {
    const parentId = session.parent_session_id;
    if (!parentId) return;

    this.backgroundTasks.submit(
      () =>
        this.sessions.fetch(parentId, SessionInternalPaths.childSessionUpdate, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            childSessionId,
            status: update.status,
            statusRevision: update.statusRevision,
            title: update.title,
            ...(update.childResult ? { childResult: update.childResult } : {}),
          }),
        }),
      {
        name: "session.notify_parent",
        context: {
          parent_id: parentId,
          child_id: childSessionId,
          status: update.status,
        },
      }
    );
  }

  private notifyParentOfStatusChange(
    session: Pick<SessionRow, "parent_session_id" | "title">,
    childSessionId: string,
    status: SessionStatus,
    statusRevision: number,
    childResult?: ChildResultUpdate
  ): void {
    this.notifyParentOfChildUpdate(session, childSessionId, {
      status,
      statusRevision,
      title: session.title,
      ...(childResult ? { childResult } : {}),
    });
  }

  private getPublicSessionId(session: SessionRow): string {
    return session.session_name || session.id;
  }

  private async syncSessionIndexStatusAndAdmission(
    sessionId: string,
    status: SessionStatus,
    updatedAt: number,
    revision: number
  ): Promise<void> {
    const projected = await this.statusProjection.project(sessionId, status, revision, updatedAt);
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
    const session = this.repository.getSession();
    if (!session) return;

    const messageCount = this.messageRepository.getMessageCount();
    const activeDurationMs = this.messageRepository.getActiveDurationMs();
    const artifacts = this.artifactRepository.listArtifacts();
    const prCount = artifacts.filter((a) => a.type === "pr").length;

    this.backgroundTasks.submit(
      () =>
        this.sessionIndex.updateMetrics(sessionId, {
          totalCost: session.total_cost ?? 0,
          activeDurationMs,
          messageCount,
          prCount,
        }),
      {
        name: "session_index.update_metrics",
        context: { session_id: sessionId },
      }
    );
  }
}
