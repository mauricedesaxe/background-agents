import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionMessageQueue, STOP_CONFIRMATION_TIMEOUT_MS } from "./message-queue";
import type { ClientInfo, ServerMessage } from "../types";
import type { MessageRow, ParticipantRow, SessionRow } from "./types";

const EXECUTION_TIMEOUT_MS = 60_000;

afterEach(() => vi.useRealTimers());

function createParticipant(overrides: Partial<ParticipantRow> = {}): ParticipantRow {
  return {
    id: "part-1",
    user_id: "user-1",
    scm_user_id: null,
    scm_login: "octocat",
    scm_email: null,
    scm_name: "Octo Cat",
    auth_name: null,
    role: "member",
    scm_access_token_encrypted: null,
    scm_refresh_token_encrypted: null,
    scm_token_expires_at: null,
    ws_auth_token: null,
    ws_token_created_at: null,
    joined_at: 1000,
    ...overrides,
  };
}

function createSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "sess-1",
    session_name: "s1",
    title: "Session",
    repo_owner: "acme",
    repo_name: "repo",
    repo_id: 1,
    base_branch: "main",
    branch_name: null,
    base_sha: null,
    current_sha: null,
    opencode_session_id: null,
    model: "anthropic/claude-haiku-4-5",
    reasoning_effort: null,
    status: "active",
    parent_session_id: null,
    spawn_source: "user" as const,
    spawn_depth: 0,
    code_server_enabled: 0,
    total_cost: 0,
    sandbox_settings: null,
    environment_id: null,
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

function createMessage(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "msg-1",
    author_id: "part-1",
    content: "hello",
    source: "web",
    model: null,
    reasoning_effort: null,
    attachments: null,
    callback_context: null,
    status: "pending",
    error_message: null,
    created_at: 1000,
    started_at: null,
    completed_at: null,
    ...overrides,
  };
}

function createClientInfo(overrides: Partial<ClientInfo> = {}): ClientInfo {
  return {
    participantId: "part-1",
    userId: "user-1",
    name: "User",
    status: "active",
    lastSeen: 1000,
    clientId: "client-1",
    ws: {} as WebSocket,
    ...overrides,
  };
}

function buildQueue() {
  const getSession = vi.fn(() => createSession());
  const repository = {
    getSession,
    createMessage: vi.fn(),
    createEvent: vi.fn(),
    getPendingOrProcessingCount: vi.fn(() => 1),
    getMessageById: vi.fn(() => null as MessageRow | null),
    getPendingMessages: vi.fn(() => [] as MessageRow[]),
    getProcessingMessage: vi.fn(() => null as { id: string } | null),
    getNextPendingMessage: vi.fn(() => null as MessageRow | null),
    updateMessageToProcessing: vi.fn(),
    getParticipantById: vi.fn(() => createParticipant()),
    updateParticipantCoalesce: vi.fn(),
    updateMessageCompletion: vi.fn(),
    upsertExecutionCompleteEvent: vi.fn(),
    getSandbox: vi.fn(
      () => null as { last_spawn_error: string | null; last_spawn_error_at: number | null } | null
    ),
  };

  const wsManager = {
    getSandboxSocket: vi.fn(() => null as WebSocket | null),
    send: vi.fn(() => true),
    close: vi.fn(),
    clearSandboxSocketIfMatch: vi.fn(() => true),
  };

  const participantService = {
    getByUserId: vi.fn(() => createParticipant()),
    create: vi.fn((userId: string, _name: string) => createParticipant({ user_id: userId })),
  };

  const callbackService = {
    notifyComplete: vi.fn(async () => {}),
  };

  const broadcast = vi.fn((_message: ServerMessage) => {});
  const messenger = { broadcast, sendToSandbox: vi.fn(() => true) };
  const sessionStatus = {
    transition: vi.fn(async (_status: string) => true),
    reconcileAfterExecution: vi.fn(async (_success: boolean) => {}),
  };
  const spawnSandbox = vi.fn(async () => {});
  const terminateSandbox = vi.fn(async (_reason: string) => {});
  const sandboxLifecycle = {
    spawnSandbox,
    terminateSandbox,
    updateLastActivity: vi.fn((_timestamp: number) => {}),
  };
  const waitUntil = vi.fn();
  const getAlarm = vi.fn(async () => null as number | null);
  const setAlarm = vi.fn(async (_timestamp: number) => {});

  const queue = new SessionMessageQueue(
    { waitUntil, storage: { getAlarm, setAlarm } } as unknown as DurableObjectState,
    {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    },
    repository as never,
    wsManager as never,
    messenger,
    participantService as never,
    callbackService as never,
    sessionStatus as never,
    sandboxLifecycle,
    null,
    "github",
    EXECUTION_TIMEOUT_MS
  );

  return {
    queue,
    repository,
    wsManager,
    participantService,
    getSession,
    broadcast,
    spawnSandbox,
    terminateSandbox,
    sessionStatus,
    sandboxLifecycle,
    getAlarm,
    setAlarm,
    waitUntil,
  };
}

describe("SessionMessageQueue", () => {
  describe("execution timeout scheduling", () => {
    function dispatchPrompt(h: ReturnType<typeof buildQueue>) {
      h.repository.getNextPendingMessage.mockReturnValue(createMessage());
      h.wsManager.getSandboxSocket.mockReturnValue({ readyState: 1 } as WebSocket);
      return h.queue.processMessageQueue();
    }

    it("schedules the execution deadline when no alarm is set", async () => {
      const h = buildQueue();
      const before = Date.now();

      await dispatchPrompt(h);

      expect(h.setAlarm).toHaveBeenCalledTimes(1);
      const deadline = h.setAlarm.mock.calls[0][0];
      expect(deadline).toBeGreaterThanOrEqual(before + EXECUTION_TIMEOUT_MS);
      expect(deadline).toBeLessThanOrEqual(Date.now() + EXECUTION_TIMEOUT_MS);
    });

    it("keeps an earlier existing alarm", async () => {
      const h = buildQueue();
      h.getAlarm.mockResolvedValue(Date.now() + 1000);

      await dispatchPrompt(h);

      expect(h.setAlarm).not.toHaveBeenCalled();
    });

    it("replaces a later existing alarm with the execution deadline", async () => {
      const h = buildQueue();
      h.getAlarm.mockResolvedValue(Date.now() + EXECUTION_TIMEOUT_MS * 10);
      const before = Date.now();

      await dispatchPrompt(h);

      expect(h.setAlarm).toHaveBeenCalledTimes(1);
      const deadline = h.setAlarm.mock.calls[0][0];
      expect(deadline).toBeGreaterThanOrEqual(before + EXECUTION_TIMEOUT_MS);
      expect(deadline).toBeLessThanOrEqual(Date.now() + EXECUTION_TIMEOUT_MS);
    });
  });

  // Upstream asserts no alarm is armed on this path. We arm the connect
  // watchdog here instead, so the deferred-spawn case diverges deliberately.
  it("spawns sandbox and arms the connect watchdog when there is work but no sandbox socket", async () => {
    const h = buildQueue();
    h.repository.getNextPendingMessage.mockReturnValue(createMessage());

    await h.queue.processMessageQueue();

    expect(h.broadcast).toHaveBeenCalledWith({ type: "sandbox_spawning" });
    expect(h.spawnSandbox).toHaveBeenCalledTimes(1);
    expect(h.setAlarm).toHaveBeenCalledTimes(1);
    expect(h.setAlarm.mock.calls[0][0]).toBeGreaterThan(Date.now());
    expect(h.repository.updateMessageToProcessing).not.toHaveBeenCalled();
  });

  it("marks session active when a prompt is enqueued", async () => {
    const h = buildQueue();

    await h.queue.handlePromptMessage({} as WebSocket, createClientInfo(), { content: "hello" });

    expect(h.sessionStatus.transition).toHaveBeenCalledWith("active");
  });

  it("broadcasts the persisted prompt queue after enqueue", async () => {
    const h = buildQueue();
    h.repository.getProcessingMessage.mockReturnValue({ id: "msg-active" });
    h.repository.getPendingMessages.mockReturnValue([
      createMessage({ id: "msg-follow-up", created_at: 2000 }),
    ]);

    await h.queue.handlePromptMessage({} as WebSocket, createClientInfo(), {
      content: "follow up",
    });

    expect(h.broadcast).toHaveBeenCalledWith({
      type: "prompt_queue",
      prompts: [
        expect.objectContaining({
          messageId: "msg-follow-up",
          position: 2,
          content: "hello",
          timestamp: 2,
        }),
      ],
    });
  });

  it("acknowledges a retried request without persisting it twice", async () => {
    const h = buildQueue();
    h.repository.getMessageById.mockReturnValue(
      createMessage({ id: "request-1", content: "follow up", status: "pending" })
    );
    h.repository.getPendingMessages.mockReturnValue([
      createMessage({ id: "request-1", content: "follow up", status: "pending" }),
    ]);

    await h.queue.handlePromptMessage({} as WebSocket, createClientInfo(), {
      requestId: "request-1",
      content: "follow up",
    });

    expect(h.repository.createMessage).not.toHaveBeenCalled();
    expect(h.wsManager.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "prompt_queued", messageId: "request-1", status: "pending" })
    );
  });

  it("acknowledges a completed retry without putting it back in the queue", async () => {
    const h = buildQueue();
    h.repository.getMessageById.mockReturnValue(
      createMessage({ id: "request-1", content: "follow up", status: "completed" })
    );

    await h.queue.handlePromptMessage({} as WebSocket, createClientInfo(), {
      requestId: "request-1",
      content: "follow up",
    });

    expect(h.wsManager.send).toHaveBeenCalledWith(expect.anything(), {
      type: "prompt_queued",
      messageId: "request-1",
      status: "completed",
    });
    expect(h.broadcast).toHaveBeenCalledWith({ type: "prompt_queue", prompts: [] });
  });

  it("returns the active prompt for reconnect hydration", () => {
    const h = buildQueue();
    h.repository.getProcessingMessage.mockReturnValue({ id: "message-active" });
    h.repository.getMessageById.mockReturnValue(
      createMessage({ id: "message-active", content: "active", status: "processing" })
    );

    expect(h.queue.getActivePrompt()).toEqual(
      expect.objectContaining({ messageId: "message-active", position: 1, content: "active" })
    );
  });

  it("rejects reuse of a request ID for different content", async () => {
    const h = buildQueue();
    h.repository.getMessageById.mockReturnValue(
      createMessage({ id: "request-1", content: "original" })
    );

    await h.queue.handlePromptMessage({} as WebSocket, createClientInfo(), {
      requestId: "request-1",
      content: "different",
    });

    expect(h.repository.createMessage).not.toHaveBeenCalled();
    expect(h.wsManager.send).toHaveBeenCalledWith(expect.anything(), {
      type: "prompt_rejected",
      requestId: "request-1",
      message: "Request ID belongs to another prompt",
    });
  });

  it.each([
    {
      field: "model",
      existing: { model: "anthropic/claude-sonnet-4-6" },
      retry: { model: "openai/gpt-5.6-sol" },
    },
    {
      field: "reasoning effort",
      existing: { model: "openai/gpt-5.6-sol", reasoning_effort: "low" },
      retry: { model: "openai/gpt-5.6-sol", reasoningEffort: "high" },
    },
    {
      field: "attachments",
      existing: {
        attachments: JSON.stringify([{ attachmentId: "attachment-1", name: "first.png" }]),
      },
      retry: { attachments: [{ attachmentId: "attachment-2", name: "second.png" }] },
    },
  ])("rejects reuse of a request ID for different $field", async ({ existing, retry }) => {
    const h = buildQueue();
    h.repository.getMessageById.mockReturnValue(
      createMessage({ id: "request-1", content: "same content", ...existing })
    );

    await h.queue.handlePromptMessage({} as WebSocket, createClientInfo(), {
      requestId: "request-1",
      content: "same content",
      ...retry,
    });

    expect(h.repository.createMessage).not.toHaveBeenCalled();
    expect(h.wsManager.send).toHaveBeenCalledWith(expect.anything(), {
      type: "prompt_rejected",
      requestId: "request-1",
      message: "Request ID belongs to another prompt",
    });
  });

  it("uses the provider-agnostic auth name for user messages without SCM identity", () => {
    const h = buildQueue();
    const participant = createParticipant({
      scm_name: null,
      scm_login: null,
      auth_name: "Pat PM",
    });

    h.queue.writeUserMessageEvent(participant, "hello", "msg-1", 1000);

    expect(h.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "sandbox_event",
        event: expect.objectContaining({
          author: expect.objectContaining({ name: "Pat PM" }),
        }),
      })
    );
  });

  it("dispatches prompt command when sandbox socket exists", async () => {
    const h = buildQueue();
    const sandboxWs = { readyState: WebSocket.OPEN } as WebSocket;
    h.repository.getNextPendingMessage.mockReturnValue(createMessage({ id: "msg-42" }));
    h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);

    await h.queue.processMessageQueue();

    expect(h.repository.updateMessageToProcessing).toHaveBeenCalledWith(
      "msg-42",
      expect.any(Number)
    );
    expect(h.wsManager.send).toHaveBeenCalledWith(
      sandboxWs,
      expect.objectContaining({ type: "prompt", messageId: "msg-42" })
    );
    expect(h.broadcast).toHaveBeenCalledWith({ type: "processing_status", isProcessing: true });
    expect(h.broadcast).toHaveBeenCalledWith({ type: "prompt_queue", prompts: [] });
  });

  it("drops a stored effort the newly chosen model does not support", async () => {
    // The session was started on Claude at "max"; the message switches to a Gemini model,
    // whose efforts stop at "xhigh". Forwarding "max" would send an effort OpenCode cannot map.
    const h = buildQueue();
    const sandboxWs = { readyState: WebSocket.OPEN } as WebSocket;
    h.getSession.mockReturnValue(
      createSession({ model: "anthropic/claude-haiku-4-5", reasoning_effort: "max" })
    );
    h.repository.getNextPendingMessage.mockReturnValue(
      createMessage({ model: "openrouter/google/gemini-3.1-pro-preview", reasoning_effort: null })
    );
    h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);

    await h.queue.processMessageQueue();

    expect(h.wsManager.send).toHaveBeenCalledWith(
      sandboxWs,
      expect.objectContaining({
        model: "openrouter/google/gemini-3.1-pro-preview",
        reasoningEffort: "high",
      })
    );
  });

  it("keeps a stored effort the newly chosen model does support", async () => {
    const h = buildQueue();
    const sandboxWs = { readyState: WebSocket.OPEN } as WebSocket;
    h.getSession.mockReturnValue(
      createSession({ model: "anthropic/claude-haiku-4-5", reasoning_effort: "low" })
    );
    h.repository.getNextPendingMessage.mockReturnValue(
      createMessage({ model: "openrouter/google/gemini-3.1-pro-preview", reasoning_effort: null })
    );
    h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);

    await h.queue.processMessageQueue();

    expect(h.wsManager.send).toHaveBeenCalledWith(
      sandboxWs,
      expect.objectContaining({ reasoningEffort: "low" })
    );
  });

  it("waits for stop confirmation before falling back to synthetic completion", async () => {
    vi.useFakeTimers();
    const h = buildQueue();
    const sandboxWs = { readyState: WebSocket.OPEN } as WebSocket;
    h.repository.getProcessingMessage.mockReturnValue({ id: "msg-9" });
    h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);

    await h.queue.stopExecution();

    expect(h.repository.updateMessageCompletion).not.toHaveBeenCalled();
    expect(h.wsManager.send).toHaveBeenCalledWith(sandboxWs, { type: "stop" });

    await vi.advanceTimersByTimeAsync(STOP_CONFIRMATION_TIMEOUT_MS);
    await h.waitUntil.mock.calls[0][0];

    expect(h.repository.updateMessageCompletion).toHaveBeenCalledWith(
      "msg-9",
      "failed",
      expect.any(Number)
    );
    expect(h.repository.upsertExecutionCompleteEvent).toHaveBeenCalledWith(
      "msg-9",
      expect.objectContaining({ type: "execution_complete", success: false }),
      expect.any(Number)
    );
    expect(h.broadcast).toHaveBeenCalledWith({ type: "processing_status", isProcessing: false });
    expect(h.wsManager.close).toHaveBeenCalledWith(sandboxWs, 1012, "Stop confirmation timed out");
    expect(h.terminateSandbox).toHaveBeenCalledWith("stop_confirmation_timeout");
    expect(h.sessionStatus.reconcileAfterExecution).toHaveBeenCalledWith(false);
    vi.useRealTimers();
  });

  it("terminates a replacement sandbox before dispatching queued work after an unconfirmed stop", async () => {
    vi.useFakeTimers();
    const h = buildQueue();
    const originalWs = { readyState: WebSocket.OPEN } as WebSocket;
    const replacementWs = { readyState: WebSocket.OPEN } as WebSocket;
    h.repository.getProcessingMessage.mockReturnValue({ id: "msg-9" });
    h.repository.updateMessageCompletion.mockImplementation(() => {
      h.repository.getProcessingMessage.mockReturnValue(null);
    });
    h.repository.getNextPendingMessage.mockReturnValue(createMessage({ id: "msg-next" }));
    h.wsManager.getSandboxSocket.mockReturnValue(originalWs);
    h.terminateSandbox.mockImplementation(async () => {
      h.wsManager.getSandboxSocket.mockReturnValue(null);
    });

    await h.queue.stopExecution();
    h.wsManager.getSandboxSocket.mockReturnValue(replacementWs);

    await vi.advanceTimersByTimeAsync(STOP_CONFIRMATION_TIMEOUT_MS);
    await h.waitUntil.mock.calls[0][0];

    expect(h.terminateSandbox).toHaveBeenCalledWith("stop_confirmation_timeout");
    expect(h.wsManager.send).not.toHaveBeenCalledWith(
      replacementWs,
      expect.objectContaining({ type: "prompt" })
    );
  });

  it("forwards stop without a processing message so compaction can cancel", async () => {
    const h = buildQueue();
    const sandboxWs = { readyState: WebSocket.OPEN } as WebSocket;
    h.repository.getProcessingMessage.mockReturnValue(null);
    h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);

    await h.queue.stopExecution();

    expect(h.wsManager.send).toHaveBeenCalledWith(sandboxWs, { type: "stop" });
    expect(h.repository.updateMessageCompletion).not.toHaveBeenCalled();
  });

  it("suppresses session status reconcile when stopExecution is called with suppress flag", async () => {
    const h = buildQueue();
    h.repository.getProcessingMessage.mockReturnValue({ id: "msg-10" });

    await h.queue.stopExecution({ suppressStatusReconcile: true });

    expect(h.sessionStatus.reconcileAfterExecution).not.toHaveBeenCalled();
  });

  it("reconciles session status when failing a stuck processing message", async () => {
    const h = buildQueue();
    h.repository.getProcessingMessage.mockReturnValue({ id: "msg-timeout" });

    await h.queue.failStuckProcessingMessage({ type: "execution_timeout", elapsedMs: 90 * 60_000 });

    expect(h.sessionStatus.reconcileAfterExecution).toHaveBeenCalledWith(false);
  });

  describe("failStuckProcessingMessage cause messages", () => {
    function errorFor(cause: Parameters<SessionMessageQueue["failStuckProcessingMessage"]>[0]) {
      const h = buildQueue();
      h.repository.getProcessingMessage.mockReturnValue({ id: "msg-x" });
      return h.queue.failStuckProcessingMessage(cause).then(() => {
        const [, event] = h.repository.upsertExecutionCompleteEvent.mock.calls[0];
        return (event as { error: string }).error;
      });
    }

    it("surfaces the execution timeout duration in minutes", async () => {
      expect(await errorFor({ type: "execution_timeout", elapsedMs: 90 * 60_000 })).toBe(
        "Execution timed out after 90m"
      );
    });

    it("produces three distinct durable messages across its three callers", async () => {
      const executionTimeout = await errorFor({
        type: "execution_timeout",
        elapsedMs: 90 * 60_000,
      });
      const heartbeatStale = await errorFor({
        type: "sandbox_terminating",
        reason: "heartbeat_stale",
      });
      const connectingTimeout = await errorFor({
        type: "sandbox_terminating",
        reason: "connecting_timeout",
      });

      const messages = [executionTimeout, heartbeatStale, connectingTimeout];
      expect(new Set(messages).size).toBe(3);
      expect(heartbeatStale).toContain("stopped responding");
    });

    it("does not launder the terminating cause into the execution-timeout string", async () => {
      const message = await errorFor({ type: "sandbox_terminating", reason: "stopped" });
      expect(message).not.toContain("timed out");
    });
  });

  describe("failStuckPendingMessage", () => {
    it("fails an aged-out pending message and persists a durable error event", async () => {
      const h = buildQueue();
      h.wsManager.getSandboxSocket.mockReturnValue(null);
      h.repository.getProcessingMessage.mockReturnValue(null);
      h.repository.getNextPendingMessage.mockReturnValue(
        createMessage({ id: "msg-stuck", created_at: 0 })
      );

      await h.queue.failStuckPendingMessage();

      expect(h.repository.updateMessageCompletion).toHaveBeenCalledWith(
        "msg-stuck",
        "failed",
        expect.any(Number)
      );
      // Durable event (getReplay reads this store), not just a transient broadcast.
      expect(h.repository.upsertExecutionCompleteEvent).toHaveBeenCalledWith(
        "msg-stuck",
        expect.objectContaining({ type: "execution_complete", success: false }),
        expect.any(Number)
      );
      expect(h.broadcast).toHaveBeenCalledWith({
        type: "processing_status",
        isProcessing: false,
      });
      expect(h.sessionStatus.reconcileAfterExecution).toHaveBeenCalledWith(false);
    });

    it("surfaces the recorded spawn error when one is present", async () => {
      const h = buildQueue();
      h.wsManager.getSandboxSocket.mockReturnValue(null);
      h.repository.getProcessingMessage.mockReturnValue(null);
      h.repository.getNextPendingMessage.mockReturnValue(
        createMessage({ id: "msg-quota", created_at: 100 })
      );
      h.repository.getSandbox.mockReturnValue({
        last_spawn_error: "Total disk limit exceeded",
        last_spawn_error_at: 100,
      });

      await h.queue.failStuckPendingMessage();

      expect(h.repository.upsertExecutionCompleteEvent).toHaveBeenCalledWith(
        "msg-quota",
        expect.objectContaining({ error: "Total disk limit exceeded" }),
        expect.any(Number)
      );
    });

    it("ignores a spawn error older than the pending message", async () => {
      const h = buildQueue();
      h.wsManager.getSandboxSocket.mockReturnValue(null);
      h.repository.getProcessingMessage.mockReturnValue(null);
      h.repository.getNextPendingMessage.mockReturnValue(
        createMessage({ id: "msg-later", created_at: 100 })
      );
      // Error recorded before this prompt was queued: a stale cause, not this one.
      h.repository.getSandbox.mockReturnValue({
        last_spawn_error: "Total disk limit exceeded",
        last_spawn_error_at: 50,
      });

      await h.queue.failStuckPendingMessage();

      expect(h.repository.upsertExecutionCompleteEvent).toHaveBeenCalledWith(
        "msg-later",
        expect.objectContaining({
          error: "Sandbox failed to start (timed out waiting to connect)",
        }),
        expect.any(Number)
      );
    });

    it("falls back to the generic connect-timeout string when no spawn error was recorded", async () => {
      const h = buildQueue();
      h.wsManager.getSandboxSocket.mockReturnValue(null);
      h.repository.getProcessingMessage.mockReturnValue(null);
      h.repository.getNextPendingMessage.mockReturnValue(
        createMessage({ id: "msg-timeout", created_at: 0 })
      );
      h.repository.getSandbox.mockReturnValue({
        last_spawn_error: null,
        last_spawn_error_at: null,
      });

      await h.queue.failStuckPendingMessage();

      expect(h.repository.upsertExecutionCompleteEvent).toHaveBeenCalledWith(
        "msg-timeout",
        expect.objectContaining({
          error: "Sandbox failed to start (timed out waiting to connect)",
        }),
        expect.any(Number)
      );
    });

    it("does nothing when a sandbox is connected", async () => {
      const h = buildQueue();
      h.wsManager.getSandboxSocket.mockReturnValue({} as WebSocket);
      h.repository.getNextPendingMessage.mockReturnValue(
        createMessage({ id: "msg-stuck", created_at: 0 })
      );

      await h.queue.failStuckPendingMessage();

      expect(h.repository.updateMessageCompletion).not.toHaveBeenCalled();
    });

    it("does nothing when a message is already processing", async () => {
      const h = buildQueue();
      h.wsManager.getSandboxSocket.mockReturnValue(null);
      h.repository.getProcessingMessage.mockReturnValue({ id: "msg-processing" });

      await h.queue.failStuckPendingMessage();

      expect(h.repository.updateMessageCompletion).not.toHaveBeenCalled();
    });

    it("does nothing when the pending message has not aged out yet", async () => {
      const h = buildQueue();
      h.wsManager.getSandboxSocket.mockReturnValue(null);
      h.repository.getProcessingMessage.mockReturnValue(null);
      h.repository.getNextPendingMessage.mockReturnValue(
        createMessage({ id: "msg-fresh", created_at: Date.now() })
      );

      await h.queue.failStuckPendingMessage();

      expect(h.repository.updateMessageCompletion).not.toHaveBeenCalled();
    });
  });

  describe("enqueuePromptFromApi", () => {
    it("creates participant with authorDisplayName when new", async () => {
      const h = buildQueue();
      h.participantService.getByUserId.mockReturnValue(null as unknown as ParticipantRow);

      await h.queue.enqueuePromptFromApi({
        content: "Fix bug",
        authorId: "github:1001",
        source: "github-bot",
        authorDisplayName: "Octo Cat",
      });

      expect(h.participantService.create).toHaveBeenCalledWith("github:1001", "Octo Cat");
    });

    it("uses authorId as display name when authorDisplayName is missing", async () => {
      const h = buildQueue();
      h.participantService.getByUserId.mockReturnValue(null as unknown as ParticipantRow);

      await h.queue.enqueuePromptFromApi({
        content: "Fix bug",
        authorId: "github:1001",
        source: "github-bot",
      });

      expect(h.participantService.create).toHaveBeenCalledWith("github:1001", "github:1001");
    });

    it("runs COALESCE update when enrichment fields are provided", async () => {
      const h = buildQueue();

      await h.queue.enqueuePromptFromApi({
        content: "Fix bug",
        authorId: "github:1001",
        source: "github-bot",
        authorDisplayName: "Octo Cat",
        authorEmail: "1001+octocat@users.noreply.github.com",
        authorLogin: "octocat",
        scmUserId: "1001",
        scmAccessTokenEncrypted: "enc-access",
        scmRefreshTokenEncrypted: "enc-refresh",
        scmTokenExpiresAt: 9999999,
      });

      expect(h.repository.updateParticipantCoalesce).toHaveBeenCalledWith("part-1", {
        scmName: "Octo Cat",
        scmEmail: "1001+octocat@users.noreply.github.com",
        scmLogin: "octocat",
        scmUserId: "1001",
        scmAccessTokenEncrypted: "enc-access",
        scmRefreshTokenEncrypted: "enc-refresh",
        scmTokenExpiresAt: 9999999,
      });
      expect(h.repository.getParticipantById).toHaveBeenCalledWith("part-1");
    });

    it("skips COALESCE when no enrichment fields are provided", async () => {
      const h = buildQueue();

      await h.queue.enqueuePromptFromApi({
        content: "Fix bug",
        authorId: "github:1001",
        source: "github-bot",
      });

      expect(h.repository.updateParticipantCoalesce).not.toHaveBeenCalled();
    });
  });
});
