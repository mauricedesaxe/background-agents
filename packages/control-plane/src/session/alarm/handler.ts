import type { Logger } from "../../logger";
import { evaluateExecutionTimeout } from "../../sandbox/lifecycle/decisions";
import type { SandboxLifecycleManager } from "../../sandbox/lifecycle/manager";
import type { SessionMessageQueue } from "../message-queue";
import type { SessionRepository } from "../repository";
import type { SessionStatusService } from "../session-status-service";

export interface AlarmHandlerDeps {
  repository: Pick<SessionRepository, "getProcessingMessageWithStartedAt">;
  messageQueue: Pick<
    SessionMessageQueue,
    "failStuckProcessingMessage" | "failStuckPendingMessage" | "processMessageQueue"
  >;
  lifecycleManager: Pick<SandboxLifecycleManager, "handleAlarm">;
  statusService: Pick<SessionStatusService, "handleAutoArchiveAlarm">;
  executionTimeoutMs: number;
  now: () => number;
  /** Session-scoped logger — alarms run outside any request, so there is no request correlation. */
  log: Logger;
}

export interface AlarmHandler {
  handle: () => Promise<void>;
}

/**
 * Durable Object alarm handler.
 *
 * Checks for stuck processing messages (defense-in-depth execution timeout)
 * before delegating to lifecycle alarm processing.
 */
export function createAlarmHandler(deps: AlarmHandlerDeps): AlarmHandler {
  return {
    async handle(): Promise<void> {
      let executionTimedOut = false;
      // Execution timeout check: if a message has been in 'processing' longer than
      // the configured timeout, fail it. This is idempotent - if the message was
      // already failed (by onSandboxTerminating or a prior alarm),
      // getProcessingMessageWithStartedAt() returns null.
      const processing = deps.repository.getProcessingMessageWithStartedAt();
      if (processing?.started_at) {
        const now = deps.now();
        const result = evaluateExecutionTimeout(
          processing.started_at,
          { timeoutMs: deps.executionTimeoutMs },
          now
        );
        if (result.isTimedOut) {
          executionTimedOut = true;
          deps.log.warn("Execution timeout: message stuck in processing", {
            event: "execution.timeout",
            message_id: processing.id,
            elapsed_ms: result.elapsedMs,
            timeout_ms: deps.executionTimeoutMs,
          });
          try {
            await deps.messageQueue.failStuckProcessingMessage({
              type: "execution_timeout",
              elapsedMs: result.elapsedMs,
            });
          } catch (error) {
            await deps.lifecycleManager.handleAlarm({ executionTimedOut: true });
            throw error;
          }
        }
      }

      // Pending-message watchdog: fail a message whose spawned/resumed sandbox
      // never connected. Self-guards (still pending, no sandbox, not processing,
      // aged out), so it's safe to run on every alarm regardless of what armed it.
      await deps.messageQueue.failStuckPendingMessage();

      await deps.statusService.handleAutoArchiveAlarm(deps.now());

      const canAdvanceQueue = await deps.lifecycleManager.handleAlarm({ executionTimedOut });
      if (canAdvanceQueue) await deps.messageQueue.processMessageQueue();
    },
  };
}
