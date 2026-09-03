import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../logger";
import { createAlarmHandler } from "./handler";
import type { MessageRepository } from "../message-repository";
import { createEarliestAlarmScheduler } from "./scheduler";

function createHandler() {
  const repository = {
    getProcessingMessageWithStartedAt: vi.fn(),
  };
  const messageQueue = {
    failExecutionWatchdogMessage: vi.fn<() => Promise<void>>().mockResolvedValue(),
    recoverStopConfirmationTimeout: vi.fn<() => Promise<void>>().mockResolvedValue(),
  };
  const lifecycleManager = {
    handleAlarm: vi
      .fn<(context: { isMessageProcessing: boolean }) => Promise<void>>()
      .mockResolvedValue(),
  };
  const alarmScheduler = {
    schedule: vi.fn<(timestamp: number) => Promise<void>>().mockResolvedValue(),
    cancel: vi.fn<() => Promise<void>>().mockResolvedValue(),
    current: vi.fn<() => Promise<number | null>>().mockResolvedValue(null),
  };
  const now = vi.fn(() => 2000);
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;

  const handler = createAlarmHandler({
    repository: repository as unknown as MessageRepository,
    messageQueue,
    lifecycleManager,
    alarmScheduler,
    executionTimeoutMs: 1000,
    now,
    log,
  });

  return {
    handler,
    repository,
    messageQueue,
    lifecycleManager,
    alarmScheduler,
    now,
    log,
  };
}

describe("createAlarmHandler", () => {
  it("delegates to lifecycle manager when no processing message exists", async () => {
    const { handler, repository, messageQueue, lifecycleManager, alarmScheduler, now } =
      createHandler();
    repository.getProcessingMessageWithStartedAt.mockReturnValue(null);

    await handler.handle();

    expect(now).not.toHaveBeenCalled();
    expect(alarmScheduler.schedule).not.toHaveBeenCalled();
    expect(messageQueue.failExecutionWatchdogMessage).not.toHaveBeenCalled();
    expect(messageQueue.recoverStopConfirmationTimeout).toHaveBeenCalledOnce();
    expect(lifecycleManager.handleAlarm).toHaveBeenCalledWith({ isMessageProcessing: false });
  });

  it("does not fail processing message when execution timeout is not reached", async () => {
    const { handler, repository, messageQueue, lifecycleManager, alarmScheduler, log } =
      createHandler();
    repository.getProcessingMessageWithStartedAt.mockReturnValue({
      id: "message-1",
      started_at: 1500,
    });

    await handler.handle();

    expect(log.warn).not.toHaveBeenCalled();
    expect(messageQueue.failExecutionWatchdogMessage).not.toHaveBeenCalled();
    expect(alarmScheduler.schedule).toHaveBeenCalledWith(2500);
    expect(lifecycleManager.handleAlarm).toHaveBeenCalledWith({ isMessageProcessing: true });
  });

  it("keeps the execution deadline ahead of a later lifecycle check", async () => {
    let currentAlarm: number | null = null;
    const storage = {
      getAlarm: vi.fn(async () => currentAlarm),
      setAlarm: vi.fn(async (timestamp: number) => {
        currentAlarm = timestamp;
      }),
      deleteAlarm: vi.fn(async () => {
        currentAlarm = null;
      }),
    };
    const alarmScheduler = createEarliestAlarmScheduler(storage, {
      pending: vi.fn(() => null),
      earliest: vi.fn(() => null),
      cancelled: vi.fn(() => false),
      setPending: vi.fn(),
      activate: vi.fn(),
      clear: vi.fn(),
      beginDelivery: vi.fn(() => null),
      completeDelivery: vi.fn(),
    });
    const lifecycleManager = {
      handleAlarm: vi.fn(async (_context: { isMessageProcessing: boolean }) =>
        alarmScheduler.schedule(5000)
      ),
    };
    const repository = {
      getProcessingMessageWithStartedAt: vi.fn(() => ({
        id: "message-1",
        started_at: 1500,
      })),
    };
    const messageQueue = {
      failExecutionWatchdogMessage: vi.fn<() => Promise<void>>().mockResolvedValue(),
      recoverStopConfirmationTimeout: vi.fn<() => Promise<void>>().mockResolvedValue(),
    };

    const handler = createAlarmHandler({
      repository: repository as unknown as MessageRepository,
      messageQueue,
      lifecycleManager,
      alarmScheduler,
      executionTimeoutMs: 1000,
      now: () => 2000,
      log: createHandler().log,
    });

    await handler.handle();

    expect(currentAlarm).toBe(2500);
    expect(storage.setAlarm).toHaveBeenCalledTimes(1);
    expect(storage.setAlarm).toHaveBeenCalledWith(2500);
    expect(lifecycleManager.handleAlarm).toHaveBeenCalledWith({ isMessageProcessing: true });
  });

  it("fails stuck processing message when execution timeout is reached", async () => {
    const { handler, repository, messageQueue, lifecycleManager, alarmScheduler, log } =
      createHandler();
    repository.getProcessingMessageWithStartedAt.mockReturnValue({
      id: "message-1",
      started_at: 500,
    });
    messageQueue.failExecutionWatchdogMessage.mockImplementation(async () => {
      repository.getProcessingMessageWithStartedAt.mockReturnValue(null);
    });

    await handler.handle();

    expect(log.warn).toHaveBeenCalledWith("Execution timeout: message stuck in processing", {
      event: "execution.timeout",
      message_id: "message-1",
      elapsed_ms: 1500,
      timeout_ms: 1000,
    });
    expect(messageQueue.failExecutionWatchdogMessage).toHaveBeenCalledWith({
      elapsedMs: 1500,
      timeoutMs: 1000,
    });
    expect(alarmScheduler.schedule).not.toHaveBeenCalled();
    expect(lifecycleManager.handleAlarm).toHaveBeenCalledWith({ isMessageProcessing: false });
  });

  it("protects a replacement message started during watchdog recovery", async () => {
    const { handler, repository, messageQueue, lifecycleManager } = createHandler();
    repository.getProcessingMessageWithStartedAt.mockReturnValue({
      id: "timed-out-message",
      started_at: 500,
    });
    messageQueue.failExecutionWatchdogMessage.mockImplementation(async () => {
      repository.getProcessingMessageWithStartedAt.mockReturnValue({
        id: "replacement-message",
        started_at: 2000,
      });
    });

    await handler.handle();

    expect(lifecycleManager.handleAlarm).toHaveBeenCalledWith({ isMessageProcessing: true });
  });
});
