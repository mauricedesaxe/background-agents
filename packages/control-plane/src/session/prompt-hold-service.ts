import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { Logger } from "../logger";
import type { AlarmScheduler } from "../platform-ports";
import type { EventRepository } from "./event-repository";
import type { MessageRepository } from "./message-repository";
import type { QueuedPromptHold } from "./sandbox-events/runtime.handler";

/** How long a context-reset hold waits for the user before auto-releasing. */
export const CONTEXT_RESET_HOLD_TIMEOUT_MS = 10 * 60 * 1_000;

const AUTO_RELEASE_MESSAGE =
  "Context reset was auto-released after 10 minutes; the queued prompt is dispatching on the fresh context.";

/**
 * The real QueuedPromptHold. Two layers keep a context reset from silently
 * eating or bypassing queued prompts:
 *
 * - a per-message `context_reset_hold` marker on the pending messages the
 *   reset would have run on a fresh conversation, and
 * - a session-level `context_reset_pending` flag, so prompts enqueued after
 *   the divergence are held too.
 *
 * The hold arms the DO alarm for a 10-minute auto-release, so a client that
 * never acknowledges cannot hold a prompt forever. Releasing lets the queue
 * head dispatch normally; the context_reset timeline event already tells the
 * user what happened, and the auto-release adds a timeline warning of its own.
 */
export class ContextResetPromptHold implements QueuedPromptHold {
  constructor(
    private readonly messageRepository: MessageRepository,
    private readonly eventRepository: EventRepository,
    private readonly drainQueue: () => Promise<void>,
    private readonly broadcastSandboxEvent: (event: SandboxEvent) => void,
    private readonly alarmScheduler: AlarmScheduler,
    private readonly log: Logger
  ) {}

  async holdQueuedPrompt(): Promise<void> {
    const held = this.messageRepository.holdPendingMessages();
    const deadline = Date.now() + CONTEXT_RESET_HOLD_TIMEOUT_MS;
    this.messageRepository.setContextResetPending(deadline);
    await this.alarmScheduler.schedule(deadline);
    if (held === 0) {
      this.log.warn("prompt_hold.nothing_to_hold", { event: "prompt_hold.nothing_to_hold" });
      return;
    }
    this.log.info("prompt_hold.held", {
      event: "prompt_hold.held",
      held_messages: held,
      auto_release_at: deadline,
    });
  }

  /**
   * Release both hold layers. Answers `acknowledged: false` only when nothing
   * was held at all — a double-acknowledge or a race against a cancel — so
   * the acknowledge route can answer 409.
   */
  async releaseQueuedPromptHold(): Promise<{ released: number; acknowledged: boolean }> {
    const released = this.messageRepository.releaseHeldMessages();
    const acknowledged = released > 0 || this.messageRepository.isContextResetPending();
    if (!acknowledged) return { released: 0, acknowledged: false };
    this.messageRepository.clearContextResetPending();
    this.log.info("prompt_hold.released", {
      event: "prompt_hold.released",
      released_messages: released,
    });
    await this.drainQueue();
    return { released, acknowledged: true };
  }

  /**
   * Alarm-handler step: when the hold outlives its deadline, release it and
   * note the auto-release on the timeline. Returns whether it fired, so the
   * handler knows the queue moved underneath it.
   */
  async autoReleaseIfDue(): Promise<boolean> {
    if (!this.messageRepository.isContextResetPending()) return false;
    const deadline = this.messageRepository.getContextResetHoldDeadline();
    const now = Date.now();
    if (deadline === null || deadline > now) return false;

    const released = this.messageRepository.releaseHeldMessages();
    this.messageRepository.clearContextResetPending();
    this.log.warn("prompt_hold.auto_released", {
      event: "prompt_hold.auto_released",
      released_messages: released,
      deadline,
    });
    this.emitTimelineWarning(now);
    await this.drainQueue();
    return true;
  }

  /** Whether the hold still needs an alarm before `deadline`; re-arms the shared slot. */
  async rearmIfHeld(): Promise<number | null> {
    if (!this.messageRepository.isContextResetPending()) return null;
    const deadline = this.messageRepository.getContextResetHoldDeadline();
    if (deadline === null) return null;
    await this.alarmScheduler.schedule(deadline);
    return deadline;
  }

  private emitTimelineWarning(now: number): void {
    const event: Extract<SandboxEvent, { type: "warning" }> = {
      type: "warning",
      scope: "context",
      message: AUTO_RELEASE_MESSAGE,
      timestamp: Math.floor(now / 1000),
    };
    this.eventRepository.createEvent({
      id: `prompt_hold.auto_release:${now}`,
      type: event.type,
      data: JSON.stringify(event),
      messageId: null,
      createdAt: now,
    });
    this.broadcastSandboxEvent(event);
  }
}
