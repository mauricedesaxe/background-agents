import type { Logger } from "../logger";
import type { MessageRepository } from "./message-repository";
import type { QueuedPromptHold } from "./sandbox-events/runtime.handler";

/**
 * The real QueuedPromptHold: a per-message `context_reset_hold` marker on the
 * pending messages a context reset would have run on a fresh conversation.
 * Releasing the hold lets the queue head dispatch normally; the context_reset
 * timeline event already tells the user what happened, so release adds no
 * narrative of its own.
 */
export class ContextResetPromptHold implements QueuedPromptHold {
  constructor(
    private readonly messageRepository: MessageRepository,
    private readonly drainQueue: () => Promise<void>,
    private readonly log: Logger
  ) {}

  holdQueuedPrompt(): void {
    const held = this.messageRepository.holdPendingMessages();
    if (held === 0) {
      this.log.warn("prompt_hold.nothing_to_hold", { event: "prompt_hold.nothing_to_hold" });
      return;
    }
    this.log.info("prompt_hold.held", {
      event: "prompt_hold.held",
      held_messages: held,
    });
  }

  async releaseQueuedPromptHold(): Promise<{ released: number }> {
    const released = this.messageRepository.releaseHeldMessages();
    if (released === 0) return { released: 0 };
    this.log.info("prompt_hold.released", {
      event: "prompt_hold.released",
      released_messages: released,
    });
    await this.drainQueue();
    return { released };
  }
}
