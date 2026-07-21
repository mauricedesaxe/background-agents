import { generateId } from "../auth/crypto";
import type { SessionIndexStore } from "../db/session-index";
import type { Logger } from "../logger";
import {
  DEFAULT_MODEL,
  getValidModelOrDefault,
  isValidModel,
  resolveReasoningEffort,
} from "@open-inspect/shared";
import type { SessionAttachmentReference } from "@open-inspect/shared";
import type { ClientInfo, MessageSource, SandboxEvent, ServerMessage } from "../types";
import type { SourceControlProviderName } from "../source-control";
import type { SandboxLifecycle, SandboxTerminationReason } from "../sandbox/lifecycle/manager";
import type { ParticipantRow, SandboxCommand } from "./types";
import type { SessionRepository } from "./repository";
import type { SessionMessenger } from "./messenger";
import type { SessionWebSocketManager } from "./websocket-manager";
import type { ParticipantService } from "./participant-service";
import type { CallbackNotificationService } from "./callback-notification-service";
import type { SessionStatusService } from "./session-status-service";
import type { EnqueuePromptRequest } from "./services/message.service";
import { getAvatarUrl } from "./participant-service";
import { resolveParticipantName } from "./participant-name";
import { validateReasoningEffort } from "./reasoning-effort";

interface PromptMessageData {
  content: string;
  model?: string;
  reasoningEffort?: string;
  attachments?: SessionAttachmentReference[];
}

/**
 * How long a pending message may wait for a spawned/resumed sandbox to connect
 * before the watchdog fails it. Without this a spawn/resume that never yields a
 * connected sandbox leaves the message stuck at `pending` forever, and the only
 * error signal (a transient `sandbox_error` broadcast) is lost to any client
 * mid-reconnect. This is intentionally generous — cold boots plus git sync can
 * take a while — and only fires when nothing has started processing.
 */
export const PENDING_SANDBOX_CONNECT_TIMEOUT_MS = 5 * 60 * 1000;

const MS_PER_MINUTE = 60 * 1000;

/**
 * Generic connect-timeout message for a pending message whose sandbox never
 * connected and left no recorded spawn error. When a spawn error was captured
 * (see {@link SessionMessageQueue.failStuckPendingMessage}), that real cause is
 * surfaced instead.
 */
const PENDING_CONNECT_TIMEOUT_ERROR = "Sandbox failed to start (timed out waiting to connect)";

/**
 * Why a message failed, threaded to {@link SessionMessageQueue.failStuckProcessingMessage}
 * so each cause surfaces as its own honest message instead of one laundered
 * string. `execution_timeout` is the real per-message execution timeout;
 * `sandbox_terminating` is the sandbox going away mid-prompt (crash, OOM,
 * heartbeat loss, stop).
 */
export type ProcessingFailureCause =
  | { type: "execution_timeout"; elapsedMs: number }
  | { type: "sandbox_terminating"; reason: SandboxTerminationReason };

function describeProcessingFailure(cause: ProcessingFailureCause): string {
  switch (cause.type) {
    case "execution_timeout":
      return `Execution timed out after ${Math.round(cause.elapsedMs / MS_PER_MINUTE)}m`;
    case "sandbox_terminating":
      return describeSandboxTermination(cause.reason);
  }
}

function describeSandboxTermination(reason: SandboxTerminationReason): string {
  switch (reason) {
    case "heartbeat_stale":
      return "Sandbox stopped responding while running your request";
    case "connecting_timeout":
      return "Sandbox failed to connect before finishing your request";
    case "inactivity_timeout":
      return "Sandbox stopped for inactivity before finishing your request";
    case "stopped":
      return "Sandbox stopped before finishing your request";
  }
}

interface StopExecutionOptions {
  suppressStatusReconcile?: boolean;
}

export class SessionMessageQueue {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly log: Logger,
    private readonly repository: SessionRepository,
    private readonly wsManager: SessionWebSocketManager,
    private readonly messenger: SessionMessenger,
    private readonly participantService: ParticipantService,
    private readonly callbackService: CallbackNotificationService,
    private readonly sessionStatus: SessionStatusService,
    private readonly sandboxLifecycle: SandboxLifecycle,
    private readonly sessionIndex: SessionIndexStore | null,
    private readonly scmProvider: SourceControlProviderName,
    private readonly executionTimeoutMs: number
  ) {}

  /**
   * Arm the DO alarm to fire no later than `deadlineMs`. The DO has a single
   * alarm slot shared with the execution and inactivity timeouts, so the
   * earliest deadline always wins.
   */
  private async scheduleAlarm(deadlineMs: number): Promise<void> {
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (!currentAlarm || deadlineMs < currentAlarm) {
      await this.ctx.storage.setAlarm(deadlineMs);
    }
  }

  async handlePromptMessage(
    ws: WebSocket,
    client: ClientInfo,
    data: PromptMessageData
  ): Promise<void> {
    const messageId = generateId();
    const now = Date.now();

    let participant = this.participantService.getByUserId(client.userId);
    if (!participant) {
      participant = this.participantService.create(client.userId, client.name);
    }

    let messageModel: string | null = null;
    if (data.model) {
      if (isValidModel(data.model)) {
        messageModel = data.model;
      } else {
        this.log.warn("Invalid message model, ignoring override", { model: data.model });
      }
    }

    const effectiveModelForEffort =
      messageModel || this.repository.getSession()?.model || DEFAULT_MODEL;
    const messageReasoningEffort = validateReasoningEffort(
      effectiveModelForEffort,
      data.reasoningEffort,
      this.log
    );

    this.repository.createMessage({
      id: messageId,
      authorId: participant.id,
      content: data.content,
      source: "web",
      model: messageModel,
      reasoningEffort: messageReasoningEffort,
      attachments: data.attachments ? JSON.stringify(data.attachments) : null,
      status: "pending",
      createdAt: now,
    });

    await this.sessionStatus.transition("active");

    this.writeUserMessageEvent(participant, data.content, messageId, now);

    const position = this.repository.getPendingOrProcessingCount();

    this.log.info("prompt.enqueue", {
      event: "prompt.enqueue",
      message_id: messageId,
      source: "web",
      author_id: participant.id,
      user_id: client.userId,
      model: messageModel,
      reasoning_effort: messageReasoningEffort,
      content_length: data.content.length,
      has_attachments: !!data.attachments?.length,
      attachments_count: data.attachments?.length ?? 0,
      queue_position: position,
    });

    const sessionIndex = this.sessionIndex;
    if (sessionIndex) {
      const session = this.repository.getSession();
      const sessionId = session?.session_name || session?.id;
      if (sessionId) {
        this.ctx.waitUntil(
          sessionIndex.touchUpdatedAt(sessionId).catch((error) => {
            this.log.error("session_index.touch_updated_at.background_error", {
              session_id: sessionId,
              error,
            });
          })
        );
      }
    }

    this.wsManager.send(ws, {
      type: "prompt_queued",
      messageId,
      position,
    } as ServerMessage);

    await this.processMessageQueue();
  }

  async processMessageQueue(): Promise<void> {
    if (this.repository.getProcessingMessage()) {
      this.log.debug("processMessageQueue: already processing, returning");
      return;
    }

    const message = this.repository.getNextPendingMessage();
    if (!message) {
      return;
    }
    const now = Date.now();

    const sandboxWs = this.wsManager.getSandboxSocket();
    if (!sandboxWs) {
      this.log.info("prompt.dispatch", {
        event: "prompt.dispatch",
        message_id: message.id,
        outcome: "deferred",
        reason: "no_sandbox",
      });
      this.messenger.broadcast({ type: "sandbox_spawning" });
      // Arm the watchdog before spawning so a spawn/resume that never yields a
      // connected sandbox eventually fails the message instead of stalling
      // silently. A successful connect moves the message to `processing`, which
      // neutralizes the watchdog (it only acts on a still-pending message).
      await this.scheduleAlarm(now + PENDING_SANDBOX_CONNECT_TIMEOUT_MS);
      await this.sandboxLifecycle.spawnSandbox();
      return;
    }

    this.repository.updateMessageToProcessing(message.id, now);
    this.messenger.broadcast({ type: "processing_status", isProcessing: true });
    this.sandboxLifecycle.updateLastActivity(now);

    await this.scheduleAlarm(now + this.executionTimeoutMs);

    const author = this.repository.getParticipantById(message.author_id);
    const session = this.repository.getSession();
    const resolvedModel = getValidModelOrDefault(message.model || session?.model);
    const resolvedEffort = resolveReasoningEffort(
      resolvedModel,
      message.reasoning_effort ?? session?.reasoning_effort
    );

    const command: SandboxCommand = {
      type: "prompt",
      messageId: message.id,
      content: message.content,
      model: resolvedModel,
      reasoningEffort: resolvedEffort,
      author: {
        userId: author?.user_id ?? "unknown",
        scmName: author?.scm_name ?? null,
        scmEmail: author?.scm_email ?? null,
      },
      attachments: message.attachments ? JSON.parse(message.attachments) : undefined,
    };

    const sent = this.wsManager.send(sandboxWs, command);

    this.log.info("prompt.dispatch", {
      event: "prompt.dispatch",
      message_id: message.id,
      outcome: sent ? "sent" : "send_failed",
      model: resolvedModel,
      reasoning_effort: resolvedEffort,
      author_id: message.author_id,
      user_id: author?.user_id ?? "unknown",
      source: message.source,
      has_sandbox_ws: true,
      sandbox_ready_state: sandboxWs.readyState,
      queue_wait_ms: now - message.created_at,
      has_attachments: !!message.attachments,
    });
  }

  async stopExecution(options: StopExecutionOptions = {}): Promise<void> {
    const now = Date.now();
    const processingMessage = this.repository.getProcessingMessage();

    if (processingMessage) {
      this.repository.updateMessageCompletion(processingMessage.id, "failed", now);
      this.log.info("prompt.stopped", {
        event: "prompt.stopped",
        message_id: processingMessage.id,
      });

      const stopError = "Execution was stopped";
      const syntheticExecutionComplete: Extract<SandboxEvent, { type: "execution_complete" }> = {
        type: "execution_complete",
        messageId: processingMessage.id,
        success: false,
        error: stopError,
        sandboxId: "",
        timestamp: now / 1000,
      };
      this.repository.upsertExecutionCompleteEvent(
        processingMessage.id,
        syntheticExecutionComplete,
        now
      );

      this.messenger.broadcast({
        type: "sandbox_event",
        event: syntheticExecutionComplete,
      });

      this.ctx.waitUntil(
        this.callbackService.notifyComplete(processingMessage.id, false, stopError)
      );

      if (!options.suppressStatusReconcile) {
        await this.sessionStatus.reconcileAfterExecution(false);
      }
    }

    this.messenger.broadcast({ type: "processing_status", isProcessing: false });

    const sandboxWs = this.wsManager.getSandboxSocket();
    if (sandboxWs) {
      this.wsManager.send(sandboxWs, { type: "stop" });
    }
  }

  /**
   * Fail a stuck processing message with the real cause it failed for.
   *
   * Called from unrelated places (the execution-timeout alarm, and the
   * sandbox-terminating callback the lifecycle manager fires on heartbeat loss,
   * connect timeout, inactivity, or an explicit stop), so `cause` carries which
   * one happened and each surfaces as its own honest error rather than one
   * laundered string.
   *
   * Only marks the message as failed and broadcasts — does NOT send a stop command
   * to the sandbox or call processMessageQueue(). This avoids races where a new
   * prompt could be dispatched to a sandbox being shut down.
   */
  async failStuckProcessingMessage(cause: ProcessingFailureCause): Promise<void> {
    const now = Date.now();
    const processingMessage = this.repository.getProcessingMessage();
    if (!processingMessage) return;

    this.repository.updateMessageCompletion(processingMessage.id, "failed", now);

    const stuckError = describeProcessingFailure(cause);
    const syntheticEvent: Extract<SandboxEvent, { type: "execution_complete" }> = {
      type: "execution_complete",
      messageId: processingMessage.id,
      success: false,
      error: stuckError,
      sandboxId: "",
      timestamp: now / 1000,
    };
    this.repository.upsertExecutionCompleteEvent(processingMessage.id, syntheticEvent, now);
    this.messenger.broadcast({ type: "sandbox_event", event: syntheticEvent });
    this.messenger.broadcast({ type: "processing_status", isProcessing: false });
    this.ctx.waitUntil(
      this.callbackService.notifyComplete(processingMessage.id, false, stuckError)
    );
    await this.sessionStatus.reconcileAfterExecution(false);
  }

  /**
   * Watchdog for a pending message whose sandbox never connected.
   *
   * Mirrors {@link failStuckProcessingMessage} but targets `pending`: if a
   * message has been waiting past PENDING_SANDBOX_CONNECT_TIMEOUT_MS with no
   * sandbox connected and nothing processing, mark it failed and persist a
   * durable `execution_complete` error event (the same store `getReplay`
   * reads) so a reconnecting client sees the failure rather than a silent
   * stall. No-op when a sandbox connected, something is processing, or the
   * pending message hasn't actually aged out — all of which mean the normal
   * dispatch path is (or already was) handling it.
   */
  async failStuckPendingMessage(): Promise<void> {
    // A connected sandbox or an in-flight message means dispatch is handling
    // this normally; the watchdog must not interfere.
    if (this.wsManager.getSandboxSocket()) return;
    if (this.repository.getProcessingMessage()) return;

    const pending = this.repository.getNextPendingMessage();
    if (!pending) return;

    const now = Date.now();
    if (now - pending.created_at < PENDING_SANDBOX_CONNECT_TIMEOUT_MS) return;

    this.repository.updateMessageCompletion(pending.id, "failed", now);

    // A failed spawn (e.g. the Daytona disk-quota 400) records the real cause on
    // the sandbox row but only broadcasts it live; surface it here so a
    // reconnecting or autopilot client gets the real reason, not the generic one.
    // Only when the error is at least as new as this pending message, so a stale
    // error from an earlier spawn isn't pinned to a later prompt's timeout.
    const sandbox = this.repository.getSandbox();
    const spawnError =
      sandbox?.last_spawn_error && (sandbox.last_spawn_error_at ?? 0) >= pending.created_at
        ? sandbox.last_spawn_error
        : undefined;
    const timeoutError = spawnError ?? PENDING_CONNECT_TIMEOUT_ERROR;
    const syntheticEvent: Extract<SandboxEvent, { type: "execution_complete" }> = {
      type: "execution_complete",
      messageId: pending.id,
      success: false,
      error: timeoutError,
      sandboxId: "",
      timestamp: now / 1000,
    };
    this.repository.upsertExecutionCompleteEvent(pending.id, syntheticEvent, now);

    this.log.warn("prompt.pending_timeout", {
      event: "prompt.pending_timeout",
      message_id: pending.id,
      waited_ms: now - pending.created_at,
    });

    this.messenger.broadcast({ type: "sandbox_event", event: syntheticEvent });
    this.messenger.broadcast({ type: "processing_status", isProcessing: false });
    this.ctx.waitUntil(this.callbackService.notifyComplete(pending.id, false, timeoutError));
    await this.sessionStatus.reconcileAfterExecution(false);
  }

  writeUserMessageEvent(
    participant: ParticipantRow,
    content: string,
    messageId: string,
    now: number
  ): void {
    const userMessageEvent: SandboxEvent = {
      type: "user_message",
      content,
      messageId,
      timestamp: now / 1000,
      author: {
        participantId: participant.id,
        name: resolveParticipantName(participant),
        avatar: getAvatarUrl(participant.scm_login, this.scmProvider),
      },
    };
    this.repository.createEvent({
      id: generateId(),
      type: "user_message",
      data: JSON.stringify(userMessageEvent),
      messageId,
      createdAt: now,
    });
    this.messenger.broadcast({ type: "sandbox_event", event: userMessageEvent });
  }

  async enqueuePromptFromApi(
    data: EnqueuePromptRequest
  ): Promise<{ messageId: string; status: "queued" }> {
    let participant = this.participantService.getByUserId(data.authorId);
    if (!participant) {
      participant = this.participantService.create(
        data.authorId,
        data.authorDisplayName || data.authorId
      );
    }

    // COALESCE update: populate identity fields on non-owner participants
    const hasEnrichment =
      data.authorDisplayName ||
      data.authorEmail ||
      data.authorLogin ||
      data.scmUserId ||
      data.scmAccessTokenEncrypted;
    if (hasEnrichment) {
      this.repository.updateParticipantCoalesce(participant.id, {
        scmName: data.authorDisplayName ?? null,
        scmEmail: data.authorEmail ?? null,
        scmLogin: data.authorLogin ?? null,
        scmUserId: data.scmUserId ?? null,
        scmAccessTokenEncrypted: data.scmAccessTokenEncrypted ?? null,
        scmRefreshTokenEncrypted: data.scmRefreshTokenEncrypted ?? null,
        scmTokenExpiresAt: data.scmTokenExpiresAt ?? null,
      });
      participant = this.repository.getParticipantById(participant.id) ?? participant;
    }

    const messageId = generateId();
    const now = Date.now();

    let messageModel: string | null = null;
    if (data.model) {
      if (isValidModel(data.model)) {
        messageModel = data.model;
      } else {
        this.log.warn("Invalid message model in enqueue, ignoring", { model: data.model });
      }
    }

    const effectiveModelForEffort =
      messageModel || this.repository.getSession()?.model || DEFAULT_MODEL;
    const messageReasoningEffort = validateReasoningEffort(
      effectiveModelForEffort,
      data.reasoningEffort,
      this.log
    );

    this.repository.createMessage({
      id: messageId,
      authorId: participant.id,
      content: data.content,
      source: data.source as MessageSource,
      model: messageModel,
      reasoningEffort: messageReasoningEffort,
      attachments: data.attachments ? JSON.stringify(data.attachments) : null,
      callbackContext: data.callbackContext ? JSON.stringify(data.callbackContext) : null,
      status: "pending",
      createdAt: now,
    });

    await this.sessionStatus.transition("active");

    this.writeUserMessageEvent(participant, data.content, messageId, now);

    const queuePosition = this.repository.getPendingOrProcessingCount();

    this.log.info("prompt.enqueue", {
      event: "prompt.enqueue",
      message_id: messageId,
      source: data.source,
      author_id: participant.id,
      user_id: data.authorId,
      model: messageModel,
      reasoning_effort: messageReasoningEffort,
      content_length: data.content.length,
      has_attachments: !!data.attachments?.length,
      attachments_count: data.attachments?.length ?? 0,
      has_callback_context: !!data.callbackContext,
      queue_position: queuePosition,
    });

    await this.processMessageQueue();

    return { messageId, status: "queued" };
  }
}
