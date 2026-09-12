import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { Logger } from "../../logger";
import type { SessionDiffService } from "../diffs/service";
import type { EventRepository } from "../event-repository";
import type { SessionMessenger } from "../messenger";
import type { SandboxRepository } from "../sandbox-repository";
import type { SessionCoreRepository } from "../session-core-repository";
import type { SessionTitleUpdateOptions, SessionTitleUpdateResult } from "../title";
import { persistSandboxEvent, type SandboxEventContext } from "./context";

/**
 * Marks the queued prompt as held until the user acknowledges the fresh
 * context, and releases it. The sandbox-events family owns when to hold;
 * `ContextResetPromptHold` owns the message-row marker and the internal
 * acknowledge route that releases it.
 */
export interface QueuedPromptHold {
  holdQueuedPrompt(): void;
  releaseQueuedPromptHold(): void;
}

/**
 * Sandbox-runtime family: events about the sandbox itself rather than the
 * execution inside it — liveness (`heartbeat`), boot (`ready`), repository
 * sync (`git_sync`), and the runtime's title suggestion (`session_title`).
 * Heartbeat and title are pure side effects; ready and git_sync also land
 * on the timeline. Ready additionally owns the context-recovery decision:
 * when the session holds a vendor conversation id but the sandbox reports
 * it did not resume one, the divergence is surfaced on the timeline and the
 * queued prompt is held until acknowledged.
 */
export class SandboxRuntimeEventHandler {
  constructor(
    private readonly repository: SessionCoreRepository,
    private readonly sandboxRepository: SandboxRepository,
    private readonly eventRepository: EventRepository,
    private readonly messenger: SessionMessenger,
    private readonly diffService: SessionDiffService,
    private readonly applySessionTitleUpdate: (
      title: string,
      options?: SessionTitleUpdateOptions
    ) => SessionTitleUpdateResult,
    private readonly updateLastActivity: (timestamp: number) => void,
    private readonly log: Logger,
    private readonly promptHold: QueuedPromptHold
  ) {}

  handleHeartbeat(context: SandboxEventContext): void {
    this.sandboxRepository.updateSandboxHeartbeat(context.now);
    // A quiet tool call may emit no events for longer than the inactivity
    // timeout. While its message is processing, the bridge heartbeat proves
    // the sandbox is still occupied and should renew its activity timestamp.
    if (context.processingMessage !== null) {
      this.updateLastActivity(context.now);
    }
  }

  handleSessionTitle(event: Extract<SandboxEvent, { type: "session_title" }>): void {
    this.applySessionTitleUpdate(event.title, { onlyIfUnset: true });
  }

  handleReady(event: Extract<SandboxEvent, { type: "ready" }>, context: SandboxEventContext): void {
    // The runtime reports which harness actually booted; the session's
    // harness is fixed at create, so a mismatch is an image/config drift
    // worth a log line, never something to reconcile silently.
    const expectedHarness = this.repository.getSession()?.harness;
    if (event.harness && expectedHarness && event.harness !== expectedHarness) {
      this.log.warn("sandbox.harness_mismatch", {
        event: "sandbox.harness_mismatch",
        expected_harness: expectedHarness,
        reported_harness: event.harness,
      });
    }
    this.diffService.pinBaselines(event);
    // Fills the column a fresh spawn cleared; a restore has already seeded
    // the snapshot's version, which outranks whatever this sandbox reports.
    this.sandboxRepository.recordReportedSandboxRuntimeVersion(event.runtimeVersion ?? null);
    persistSandboxEvent(this.eventRepository, event, context);
    this.messenger.broadcast({ type: "sandbox_event", event });
    this.handleContextRecovery(event, context);
  }

  handleContextReset(
    event: Extract<SandboxEvent, { type: "context_reset" }>,
    context: SandboxEventContext
  ): void {
    persistSandboxEvent(this.eventRepository, event, context);
    this.messenger.broadcast({ type: "sandbox_event", event });
  }

  handleGitSync(
    event: Extract<SandboxEvent, { type: "git_sync" }>,
    context: SandboxEventContext
  ): void {
    persistSandboxEvent(this.eventRepository, event, context);
    this.sandboxRepository.updateSandboxGitSyncStatus(event.status);
    if (event.sha) {
      this.repository.updateSessionCurrentSha(event.sha);
    }
    this.messenger.broadcast({ type: "sandbox_event", event });
  }

  /**
   * A replacement sandbox that did not resume the session's vendor
   * conversation would silently run its next prompt on an empty context
   * while the timeline still shows every prior turn. Surface the reset and
   * hold the queued prompt until the user acknowledges it.
   */
  private handleContextRecovery(
    event: Extract<SandboxEvent, { type: "ready" }>,
    context: SandboxEventContext
  ): void {
    const persistedSessionId = this.repository.getSession()?.agent_session_id ?? null;
    if (!persistedSessionId) return;

    const reportedSessionId = event.opencodeSessionId ?? null;
    const reason =
      event.resumed !== true
        ? ("fresh_session" as const)
        : reportedSessionId !== persistedSessionId
          ? ("session_id_mismatch" as const)
          : null;
    if (!reason) return;

    const resetEvent: Extract<SandboxEvent, { type: "context_reset" }> = {
      type: "context_reset",
      sandboxId: event.sandboxId,
      timestamp: Math.floor(context.now / 1000),
      reason,
      agentSessionId: reportedSessionId,
    };
    this.handleContextReset(resetEvent, context);
    this.log.warn("sandbox.context_reset", {
      event: "sandbox.context_reset",
      reason,
      persisted_session_id: persistedSessionId,
      reported_session_id: reportedSessionId,
    });
    this.promptHold.holdQueuedPrompt();
  }
}
