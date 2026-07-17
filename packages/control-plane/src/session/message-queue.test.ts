import { describe, expect, it, vi } from "vitest";
import { SessionMessageQueue } from "./message-queue";
import type { ClientInfo, Env, ServerMessage } from "../types";
import type { MessageRow, ParticipantRow, SessionRow } from "./types";

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

function buildQueue(options?: { getClientInfo?: (ws: WebSocket) => ClientInfo | null }) {
  const repository = {
    createMessage: vi.fn(),
    createEvent: vi.fn(),
    getPendingOrProcessingCount: vi.fn(() => 1),
    getProcessingMessage: vi.fn(() => null as { id: string } | null),
    getNextPendingMessage: vi.fn(() => null as MessageRow | null),
    updateMessageToProcessing: vi.fn(),
    getParticipantById: vi.fn(() => createParticipant()),
    updateParticipantCoalesce: vi.fn(),
    updateMessageCompletion: vi.fn(),
    upsertExecutionCompleteEvent: vi.fn(),
    getSandbox: vi.fn(() => null as { last_spawn_error: string | null } | null),
  };

  const wsManager = {
    getSandboxSocket: vi.fn(() => null as WebSocket | null),
    send: vi.fn(() => true),
  };

  const participantService = {
    getByUserId: vi.fn(() => createParticipant()),
    create: vi.fn((userId: string, _name: string) => createParticipant({ user_id: userId })),
  };

  const callbackService = {
    notifyComplete: vi.fn(async () => {}),
  };

  const broadcast = vi.fn((_message: ServerMessage) => {});
  const spawnSandbox = vi.fn(async () => {});
  const setSessionStatus = vi.fn(async (_status: string) => {});
  const reconcileSessionStatusAfterExecution = vi.fn(async (_success: boolean) => {});
  const updateLastActivity = vi.fn();
  const scheduleSandboxConnectTimeout = vi.fn(async (_deadlineMs: number) => {});
  const waitUntil = vi.fn();
  const getSession = vi.fn(() => createSession());

  const queue = new SessionMessageQueue({
    env: {} as Env,
    ctx: { waitUntil } as unknown as DurableObjectState,
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    },
    repository: repository as never,
    wsManager: wsManager as never,
    participantService: participantService as never,
    callbackService: callbackService as never,
    scmProvider: "github",
    getClientInfo: options?.getClientInfo ?? (() => createClientInfo()),
    validateReasoningEffort: vi.fn(() => null),
    getSession,
    updateLastActivity,
    spawnSandbox,
    broadcast,
    setSessionStatus,
    reconcileSessionStatusAfterExecution,
    scheduleSandboxConnectTimeout,
  });

  return {
    queue,
    repository,
    wsManager,
    participantService,
    getSession,
    broadcast,
    spawnSandbox,
    setSessionStatus,
    reconcileSessionStatusAfterExecution,
    scheduleSandboxConnectTimeout,
    waitUntil,
  };
}

describe("SessionMessageQueue", () => {
  it("sends NOT_SUBSCRIBED when prompt arrives before subscribe", async () => {
    const h = buildQueue({ getClientInfo: () => null });

    await h.queue.handlePromptMessage({} as WebSocket, { content: "hello" });

    expect(h.wsManager.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: "NOT_SUBSCRIBED" })
    );
    expect(h.repository.createMessage).not.toHaveBeenCalled();
    expect(h.setSessionStatus).not.toHaveBeenCalled();
  });

  it("spawns sandbox and arms the connect watchdog when there is work but no sandbox socket", async () => {
    const h = buildQueue();
    h.repository.getNextPendingMessage.mockReturnValue(createMessage());

    await h.queue.processMessageQueue();

    expect(h.broadcast).toHaveBeenCalledWith({ type: "sandbox_spawning" });
    expect(h.spawnSandbox).toHaveBeenCalledTimes(1);
    expect(h.scheduleSandboxConnectTimeout).toHaveBeenCalledTimes(1);
    expect(h.scheduleSandboxConnectTimeout.mock.calls[0][0]).toBeGreaterThan(Date.now());
    expect(h.repository.updateMessageToProcessing).not.toHaveBeenCalled();
  });

  it("marks session active when a prompt is enqueued", async () => {
    const h = buildQueue();

    await h.queue.handlePromptMessage({} as WebSocket, { content: "hello" });

    expect(h.setSessionStatus).toHaveBeenCalledWith("active");
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

  it("marks processing message failed and broadcasts synthetic completion on stop", async () => {
    const h = buildQueue();
    const sandboxWs = { readyState: WebSocket.OPEN } as WebSocket;
    h.repository.getProcessingMessage.mockReturnValue({ id: "msg-9" });
    h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);

    await h.queue.stopExecution();

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
    expect(h.wsManager.send).toHaveBeenCalledWith(sandboxWs, { type: "stop" });
    expect(h.waitUntil).toHaveBeenCalledTimes(1);
    expect(h.reconcileSessionStatusAfterExecution).toHaveBeenCalledWith(false);
  });

  it("suppresses session status reconcile when stopExecution is called with suppress flag", async () => {
    const h = buildQueue();
    h.repository.getProcessingMessage.mockReturnValue({ id: "msg-10" });

    await h.queue.stopExecution({ suppressStatusReconcile: true });

    expect(h.reconcileSessionStatusAfterExecution).not.toHaveBeenCalled();
  });

  it("reconciles session status when failing a stuck processing message", async () => {
    const h = buildQueue();
    h.repository.getProcessingMessage.mockReturnValue({ id: "msg-timeout" });

    await h.queue.failStuckProcessingMessage({ type: "execution_timeout", elapsedMs: 90 * 60_000 });

    expect(h.reconcileSessionStatusAfterExecution).toHaveBeenCalledWith(false);
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
      expect(h.reconcileSessionStatusAfterExecution).toHaveBeenCalledWith(false);
    });

    it("surfaces the recorded spawn error when one is present", async () => {
      const h = buildQueue();
      h.wsManager.getSandboxSocket.mockReturnValue(null);
      h.repository.getProcessingMessage.mockReturnValue(null);
      h.repository.getNextPendingMessage.mockReturnValue(
        createMessage({ id: "msg-quota", created_at: 0 })
      );
      h.repository.getSandbox.mockReturnValue({
        last_spawn_error: "Total disk limit exceeded",
      });

      await h.queue.failStuckPendingMessage();

      expect(h.repository.upsertExecutionCompleteEvent).toHaveBeenCalledWith(
        "msg-quota",
        expect.objectContaining({ error: "Total disk limit exceeded" }),
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
      h.repository.getSandbox.mockReturnValue({ last_spawn_error: null });

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
