import type { Logger } from "../logger";
import type { MessageRepository } from "./message-repository";
import type { QueuedPromptHold } from "./sandbox-events/runtime.handler";

/**
 * The real QueuedPromptHold. Two layers keep a context reset from silently
 * eating or bypassing queued prompts:
 *
 * - a per-message `context_reset_hold` marker on the pending messages the
 *   reset would have run on a fresh conversation, and
 * - a session-level `context_reset_pending` flag, so prompts enqueued after
 *   the divergence are held too.
 *
 * The hold fails closed until explicit acknowledgement releases it.
 */
export class ContextResetPromptHold implements QueuedPromptHold {
  constructor(
    private readonly messageRepository: MessageRepository,
    private readonly drainQueue: () => Promise<void>,
    private readonly log: Logger
  ) {}

  async holdQueuedPrompt(): Promise<void> {
    const held = this.messageRepository.holdPendingMessages();
    this.messageRepository.setContextResetPending();
    if (held === 0) {
      this.log.warn("prompt_hold.nothing_to_hold", { event: "prompt_hold.nothing_to_hold" });
      return;
    }
    this.log.info("prompt_hold.held", {
      event: "prompt_hold.held",
      held_messages: held,
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
}
