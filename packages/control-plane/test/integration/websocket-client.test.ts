import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { SessionDO } from "../../src/session/durable-object";
import {
  initNamedSession,
  openClientWs,
  collectMessages,
  seedEvents,
  queryDO,
  waitForSandboxStatus,
  openSandboxWs,
  seedSandboxAuth,
} from "./helpers";

const SANDBOX_TOKEN = "test-sandbox-token";
const SANDBOX_ID = "test-sandbox-id";

describe("Client WebSocket (via SELF.fetch)", () => {
  it("upgrade returns 101 with webSocket", async () => {
    const name = `ws-client-upgrade-${Date.now()}`;
    await initNamedSession(name);

    const { ws } = await openClientWs(name);
    expect(ws).not.toBeNull();
    // Clean up
    ws.close();
  });

  it("rejects a prompt sent before subscribing without enqueuing it", async () => {
    const name = `ws-client-nosub-prompt-${Date.now()}`;
    await initNamedSession(name);

    const { ws } = await openClientWs(name);

    const closed = new Promise<{ code: number }>((resolve) => {
      ws.addEventListener("close", (evt) => resolve({ code: evt.code }));
    });

    ws.send(JSON.stringify({ type: "prompt", content: "hello" }));

    // Unsubscribed sockets have no client mapping — the DO closes them
    // with 4002 and never enqueues the prompt.
    const { code } = await closed;
    expect(code).toBe(4002);

    const id = env.SESSION.idFromName(name);
    const stub = env.SESSION.get(id);
    const rows = await queryDO<{ count: number }>(stub, "SELECT COUNT(*) AS count FROM messages");
    expect(rows[0].count).toBe(0);
  });

  it("subscribe with valid token sends subscribed + state", async () => {
    const name = `ws-client-sub-${Date.now()}`;
    await initNamedSession(name, { repoOwner: "acme", repoName: "web-app" });

    const { ws, participantId, messages } = await openClientWs(name, { subscribe: true });

    const subscribed = messages!.find((m) => m.type === "subscribed") as Record<string, unknown>;
    expect(subscribed).toBeDefined();
    expect(subscribed.sessionId).toBe(name);
    expect(subscribed.participantId).toBe(participantId);

    const state = subscribed.state as Record<string, unknown>;
    expect(state.id).toBe(name);
    expect(state.repoOwner).toBe("acme");

    ws.close();
  });

  it("subscribe hydrates dashboard URL when provider object id exists", async () => {
    const dashboardUrl =
      "https://modal.com/apps/test-workspace/main/deployed/open-inspect?activeTab=sandboxes&sandboxId=provider-obj-123";
    const cases = [
      {
        status: "connecting",
        providerObjectId: "provider-obj-123",
        expectedDashboardUrl: dashboardUrl,
      },
      {
        status: "spawning",
        providerObjectId: "provider-obj-123",
        expectedDashboardUrl: dashboardUrl,
      },
      { status: "spawning", providerObjectId: null, expectedDashboardUrl: null },
      { status: "stale", providerObjectId: "provider-obj-123", expectedDashboardUrl: dashboardUrl },
      {
        status: "stopped",
        providerObjectId: "provider-obj-123",
        expectedDashboardUrl: dashboardUrl,
      },
      {
        status: "failed",
        providerObjectId: "provider-obj-123",
        expectedDashboardUrl: dashboardUrl,
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const name = `ws-client-dashboard-url-${testCase.status}-${testCase.providerObjectId ? "with-id" : "without-id"}-${Date.now()}-${index}`;
      const { stub } = await initNamedSession(name);
      // Wait for init's fire-and-forget warmSandbox to fail (no Modal in test env)
      // before forcing each status, otherwise it can race and overwrite the row.
      await waitForSandboxStatus(stub, "failed");
      await queryDO(
        stub,
        `UPDATE sandbox
           SET status = ?, modal_object_id = ?
         WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
        testCase.status,
        testCase.providerObjectId
      );

      const { ws, messages } = await openClientWs(name, { subscribe: true });
      const subscribed = messages!.find((m) => m.type === "subscribed") as Record<string, unknown>;
      const state = subscribed.state as Record<string, unknown>;

      expect(state.sandboxStatus).toBe(testCase.status);
      expect(state.sandboxDashboardUrl).toBe(testCase.expectedDashboardUrl);

      ws.close();
    }
  });

  it("subscribe with invalid token closes socket 4001", async () => {
    const name = `ws-client-badtoken-${Date.now()}`;
    await initNamedSession(name);

    const { ws } = await openClientWs(name);

    const closed = new Promise<{ code: number }>((resolve) => {
      ws.addEventListener("close", (evt) => resolve({ code: evt.code }));
    });

    ws.send(
      JSON.stringify({
        type: "subscribe",
        token: "totally-invalid-token",
        clientId: "test-client",
      })
    );

    const { code } = await closed;
    expect(code).toBe(4001);
  });

  it("subscribe without token closes socket 4001", async () => {
    const name = `ws-client-notoken-${Date.now()}`;
    await initNamedSession(name);

    const { ws } = await openClientWs(name);

    const closed = new Promise<{ code: number }>((resolve) => {
      ws.addEventListener("close", (evt) => resolve({ code: evt.code }));
    });

    ws.send(
      JSON.stringify({
        type: "subscribe",
        token: "",
        clientId: "test-client",
      })
    );

    const { code } = await closed;
    expect(code).toBe(4001);
  });

  it("subscribe with expired token closes socket 4001", async () => {
    const name = `ws-client-expired-${Date.now()}`;
    const { stub } = await initNamedSession(name);

    // Generate a valid WS token
    const id = env.SESSION.idFromName(name);
    const doStub = env.SESSION.get(id);
    const tokenRes = await doStub.fetch("http://internal/internal/ws-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-1" }),
    });
    const { token } = await tokenRes.json<{ token: string }>();

    // Back-date the token past the 24-hour TTL
    const expiredAt = Date.now() - 24 * 60 * 60 * 1000 - 1;
    await queryDO(
      stub,
      "UPDATE participants SET ws_token_created_at = ? WHERE user_id = ?",
      expiredAt,
      "user-1"
    );

    // Open WS and try to subscribe with the expired token
    const { ws } = await openClientWs(name);

    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.addEventListener("close", (evt) => resolve({ code: evt.code, reason: evt.reason }));
    });

    ws.send(
      JSON.stringify({
        type: "subscribe",
        token,
        clientId: "test-client",
      })
    );

    const { code, reason } = await closed;
    expect(code).toBe(4001);
    expect(reason).toBe("Token expired");
  });

  it("subscribe includes batched replay with hasMore=false for empty session", async () => {
    const name = `ws-client-replay-empty-${Date.now()}`;
    await initNamedSession(name);

    const { ws, messages } = await openClientWs(name, { subscribe: true });

    const subscribed = messages!.find((m) => m.type === "subscribed") as Record<string, unknown>;
    expect(subscribed).toBeDefined();
    expect(subscribed.artifacts).toEqual([]);
    const replay = subscribed.replay as { events: unknown[]; hasMore: boolean; cursor: unknown };
    expect(replay).toBeDefined();
    expect(replay.hasMore).toBe(false);
    expect(replay.cursor).toBeNull();
    expect(replay.events).toHaveLength(0);

    ws.close();
  });

  it("subscribe includes historical events in batched replay", async () => {
    const name = `ws-client-replay-events-${Date.now()}`;
    const { stub } = await initNamedSession(name);

    const now = Date.now();
    await seedEvents(stub, [
      {
        id: "ev-1",
        type: "tool_call",
        data: JSON.stringify({ type: "tool_call", tool: "read_file" }),
        createdAt: now - 2000,
      },
      {
        id: "ev-2",
        type: "tool_result",
        data: JSON.stringify({ type: "tool_result", result: "ok" }),
        createdAt: now - 1000,
      },
    ]);

    const { ws, messages } = await openClientWs(name, { subscribe: true });

    const subscribed = messages!.find((m) => m.type === "subscribed") as Record<string, unknown>;
    expect(subscribed).toBeDefined();
    const replay = subscribed.replay as { events: Record<string, unknown>[]; hasMore: boolean };
    expect(replay).toBeDefined();
    expect(replay.events).toHaveLength(2);
    expect(replay.events[0].type).toBe("tool_call");
    expect(replay.events[1].type).toBe("tool_result");

    ws.close();
  });

  it("subscribe hydrates persisted PR artifacts with parsed metadata and createdAt", async () => {
    const name = `ws-client-artifacts-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    const createdAt = Date.now() - 1000;

    await queryDO(
      stub,
      "INSERT INTO artifacts (id, type, url, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      "artifact-pr-1",
      "pr",
      "https://github.com/acme/web-app/pull/42",
      JSON.stringify({
        number: 42,
        state: "open",
        head: "feature/test",
        base: "main",
      }),
      createdAt,
      createdAt
    );

    const { ws, messages } = await openClientWs(name, { subscribe: true });

    const subscribed = messages!.find((m) => m.type === "subscribed") as Record<string, unknown>;
    expect(subscribed).toBeDefined();
    expect(subscribed.artifacts).toEqual([
      {
        id: "artifact-pr-1",
        type: "pr",
        url: "https://github.com/acme/web-app/pull/42",
        metadata: {
          number: 42,
          state: "open",
          head: "feature/test",
          base: "main",
        },
        createdAt,
        updatedAt: createdAt,
      },
    ]);

    ws.close();
  });

  it("ping gets pong response", async () => {
    const name = `ws-client-ping-${Date.now()}`;
    await initNamedSession(name);

    const { ws } = await openClientWs(name);

    const collector = collectMessages(ws, {
      until: (msg) => msg.type === "pong",
      timeoutMs: 2000,
    });

    ws.send(JSON.stringify({ type: "ping" }));

    const messages = await collector;
    const pong = messages.find((m) => m.type === "pong");
    expect(pong).toBeDefined();
    expect(pong!.timestamp).toEqual(expect.any(Number));

    ws.close();
  });

  it("prompt via WS creates message and returns prompt_queued", async () => {
    const name = `ws-client-prompt-${Date.now()}`;
    const { stub } = await initNamedSession(name);

    const { ws } = await openClientWs(name, { subscribe: true });

    const collector = collectMessages(ws, {
      until: (msg) => msg.type === "prompt_queued",
      timeoutMs: 2000,
    });

    ws.send(JSON.stringify({ type: "prompt", content: "Hello from WS test" }));

    const messages = await collector;
    const queued = messages.find((m) => m.type === "prompt_queued") as Record<string, unknown>;
    expect(queued).toBeDefined();
    expect(queued.messageId).toEqual(expect.any(String));

    // Verify message exists in DB
    const rows = await queryDO<{ id: string; content: string; source: string }>(
      stub,
      "SELECT id, content, source FROM messages WHERE id = ?",
      queued.messageId
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("Hello from WS test");
    expect(rows[0].source).toBe("web");

    ws.close();
  });

  it("compacts an idle session and accepts a later prompt", async () => {
    const name = `ws-client-compact-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });
    const { ws: sandboxWs } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    sandboxWs!.accept();
    const { ws: clientWs } = await openClientWs(name, { subscribe: true });

    const sandboxMessages = collectMessages(sandboxWs!, {
      until: (message) => message.type === "compact_context",
    });
    const started = collectMessages(clientWs, {
      until: (message) =>
        message.type === "sandbox_event" && message.event.type === "context_compaction_started",
    });
    clientWs.send(
      JSON.stringify({
        type: "compact_context",
        requestId: "compact-request-1",
        model: "openai/gpt-5.6-sol",
      })
    );

    expect((await sandboxMessages).find((message) => message.type === "compact_context")).toEqual({
      type: "compact_context",
      requestId: "compact-request-1",
      model: "openai/gpt-5.6-sol",
    });
    expect(await started).toContainEqual({
      type: "sandbox_event",
      event: expect.objectContaining({
        type: "context_compaction_started",
        requestId: "compact-request-1",
        sandboxId: SANDBOX_ID,
      }),
    });

    const startedEvents = await queryDO<{ count: number }>(
      stub,
      "SELECT COUNT(*) AS count FROM events WHERE type = ?",
      "context_compaction_started"
    );
    expect(startedEvents[0].count).toBe(1);

    const completed = collectMessages(clientWs, {
      until: (message) => message.type === "compaction_status" && message.state === "completed",
    });
    sandboxWs!.send(
      JSON.stringify({
        type: "context_compacted",
        requestId: "compact-request-1",
        ackId: "context_compacted:compact-request-1",
        sandboxId: SANDBOX_ID,
        timestamp: Date.now() / 1000,
      })
    );
    expect(await completed).toContainEqual({
      type: "compaction_status",
      requestId: "compact-request-1",
      state: "completed",
    });

    const events = await queryDO<{ count: number }>(
      stub,
      "SELECT COUNT(*) AS count FROM events WHERE type = ?",
      "context_compacted"
    );
    expect(events[0].count).toBe(1);

    const duplicateAck = collectMessages(sandboxWs!, {
      until: (message) =>
        message.type === "ack" && message.ackId === "context_compacted:compact-request-1",
    });
    sandboxWs!.send(
      JSON.stringify({
        type: "context_compacted",
        requestId: "compact-request-1",
        ackId: "context_compacted:compact-request-1",
        sandboxId: SANDBOX_ID,
        timestamp: Date.now() / 1000,
      })
    );
    await duplicateAck;
    const deduplicatedEvents = await queryDO<{ count: number }>(
      stub,
      "SELECT COUNT(*) AS count FROM events WHERE type = ?",
      "context_compacted"
    );
    expect(deduplicatedEvents[0].count).toBe(1);

    const queued = collectMessages(clientWs, {
      until: (message) => message.type === "prompt_queued",
    });
    const continuedPrompt = collectMessages(sandboxWs!, {
      until: (message) => message.type === "prompt",
    });
    clientWs.send(JSON.stringify({ type: "prompt", content: "Continue after compaction" }));
    expect((await queued).some((message) => message.type === "prompt_queued")).toBe(true);
    expect(await continuedPrompt).toContainEqual(
      expect.objectContaining({ type: "prompt", content: "Continue after compaction" })
    );

    sandboxWs!.close();
    clientWs.close();
  });

  it("rejects compaction while a prompt is processing", async () => {
    const name = `ws-client-compact-busy-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });
    const { ws: sandboxWs } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    sandboxWs!.accept();
    const { ws: clientWs } = await openClientWs(name, { subscribe: true });

    const promptDispatched = collectMessages(sandboxWs!, {
      until: (message) => message.type === "prompt",
    });
    clientWs.send(JSON.stringify({ type: "prompt", content: "Keep working" }));
    await promptDispatched;

    const rejected = collectMessages(clientWs, {
      until: (message) => message.type === "error" && message.code === "SESSION_BUSY",
    });
    clientWs.send(
      JSON.stringify({
        type: "compact_context",
        requestId: "compact-request-busy",
        model: "openai/gpt-5.6-sol",
      })
    );
    expect(await rejected).toContainEqual({
      type: "error",
      code: "SESSION_BUSY",
      message: "Context can only be compacted while the session is idle",
      requestId: "compact-request-busy",
    });

    sandboxWs!.close();
    clientWs.close();
  });

  it("correlates a losing tab's rejection with the active compaction", async () => {
    const name = `ws-client-compact-two-tabs-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });
    const { ws: sandboxWs } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    sandboxWs!.accept();
    const first = await openClientWs(name, { subscribe: true });
    const second = await openClientWs(name, { subscribe: true });

    const dispatched = collectMessages(sandboxWs!, {
      until: (message) => message.type === "compact_context",
    });
    first.ws.send(
      JSON.stringify({
        type: "compact_context",
        requestId: "compact-request-first",
        model: "openai/gpt-5.6-sol",
      })
    );
    await dispatched;

    const rejected = collectMessages(second.ws, {
      until: (message) => message.type === "error" && message.code === "SESSION_BUSY",
    });
    second.ws.send(
      JSON.stringify({
        type: "compact_context",
        requestId: "compact-request-second",
        model: "openai/gpt-5.6-sol",
      })
    );
    expect(await rejected).toContainEqual({
      type: "error",
      code: "SESSION_BUSY",
      message: "Context can only be compacted while the session is idle",
      requestId: "compact-request-second",
      activeRequestId: "compact-request-first",
    });

    sandboxWs!.close();
    first.ws.close();
    second.ws.close();
  });

  it("fails compaction and accepts a later prompt when the sandbox terminates", async () => {
    const name = `ws-client-compact-terminated-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });
    const { ws: sandboxWs } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    sandboxWs!.accept();
    const { ws: clientWs } = await openClientWs(name, { subscribe: true });

    const dispatched = collectMessages(sandboxWs!, {
      until: (message) => message.type === "compact_context",
    });
    clientWs.send(
      JSON.stringify({
        type: "compact_context",
        requestId: "compact-request-terminated",
        model: "openai/gpt-5.6-sol",
      })
    );
    await dispatched;

    const failed = collectMessages(clientWs, {
      until: (message) => message.type === "compaction_status" && message.state === "failed",
    });
    sandboxWs!.close(1000, "bridge exited");
    expect(await failed).toContainEqual({
      type: "compaction_status",
      requestId: "compact-request-terminated",
      state: "failed",
      error: "Sandbox stopped before context compaction completed",
    });

    const queued = collectMessages(clientWs, {
      until: (message) => message.type === "prompt_queued",
    });
    clientWs.send(JSON.stringify({ type: "prompt", content: "Continue after bridge exit" }));
    expect((await queued).some((message) => message.type === "prompt_queued")).toBe(true);

    clientWs.close();
  });

  it("expires a compaction with no terminal bridge event", async () => {
    const name = `ws-client-compact-timeout-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });
    const { ws: sandboxWs } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    sandboxWs!.accept();
    const { ws: clientWs } = await openClientWs(name, { subscribe: true });

    const dispatched = collectMessages(sandboxWs!, {
      until: (message) => message.type === "compact_context",
    });
    clientWs.send(
      JSON.stringify({
        type: "compact_context",
        requestId: "compact-request-timeout",
        model: "openai/gpt-5.6-sol",
      })
    );
    await dispatched;

    const failed = collectMessages(clientWs, {
      until: (message) => message.type === "compaction_status" && message.state === "failed",
    });
    await runInDurableObject(stub, async (instance: SessionDO) => {
      const state = instance as unknown as {
        activeCompaction: { requestId: string; deadlineAt: number } | null;
      };
      if (!state.activeCompaction) throw new Error("Expected active compaction");
      state.activeCompaction.deadlineAt = Date.now() - 1;
      await instance.alarm();
    });
    expect(await failed).toContainEqual({
      type: "compaction_status",
      requestId: "compact-request-timeout",
      state: "failed",
      error: "Context compaction timed out after 300s",
    });

    const continuedPrompt = collectMessages(sandboxWs!, {
      until: (message) => message.type === "prompt",
    });
    clientWs.send(JSON.stringify({ type: "prompt", content: "Continue after timeout" }));
    expect(await continuedPrompt).toContainEqual(
      expect.objectContaining({ type: "prompt", content: "Continue after timeout" })
    );

    sandboxWs!.close();
    clientWs.close();
  });

  it("cancels compaction and returns the session to idle", async () => {
    const name = `ws-client-compact-cancel-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });
    const { ws: sandboxWs } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    sandboxWs!.accept();
    const { ws: clientWs } = await openClientWs(name, { subscribe: true });

    const dispatched = collectMessages(sandboxWs!, {
      until: (message) => message.type === "compact_context",
    });
    clientWs.send(
      JSON.stringify({
        type: "compact_context",
        requestId: "compact-request-cancelled",
        model: "openai/gpt-5.6-sol",
      })
    );
    await dispatched;

    const stopped = collectMessages(sandboxWs!, {
      until: (message) => message.type === "stop",
    });
    const failed = collectMessages(clientWs, {
      until: (message) => message.type === "compaction_status" && message.state === "failed",
    });
    clientWs.send(JSON.stringify({ type: "stop" }));
    expect((await stopped).some((message) => message.type === "stop")).toBe(true);
    expect(await failed).toContainEqual({
      type: "compaction_status",
      requestId: "compact-request-cancelled",
      state: "failed",
      error: "Context compaction was cancelled",
    });

    sandboxWs!.close();
    clientWs.close();
  });

  it("closing one of multiple sockets for the same participant sends presence_update, not presence_leave", async () => {
    const name = `ws-client-presence-multi-${Date.now()}`;
    await initNamedSession(name);

    // Two tabs for the same user → same participantId
    const tab1 = await openClientWs(name, { subscribe: true, userId: "user-1" });
    const tab2 = await openClientWs(name, { subscribe: true, userId: "user-1" });
    expect(tab1.participantId).toBe(tab2.participantId);

    const collector = collectMessages(tab1.ws, {
      until: (msg) => msg.type === "presence_update" || msg.type === "presence_leave",
      timeoutMs: 2000,
    });

    tab2.ws.close();

    const messages = await collector;
    expect(messages.some((m) => m.type === "presence_leave")).toBe(false);
    const update = messages.find((m) => m.type === "presence_update") as Record<string, unknown>;
    expect(update).toBeDefined();
    const participants = update.participants as Array<{ participantId: string }>;
    expect(participants.some((p) => p.participantId === tab1.participantId)).toBe(true);

    tab1.ws.close();
  });

  it("closing the only socket for a participant broadcasts presence_leave", async () => {
    const name = `ws-client-presence-leave-${Date.now()}`;
    await initNamedSession(name);

    // Two distinct users so the watcher remains connected after the target leaves
    const watcher = await openClientWs(name, { subscribe: true, userId: "user-1" });
    const leaver = await openClientWs(name, { subscribe: true, userId: "user-2" });

    const collector = collectMessages(watcher.ws, {
      until: (msg) => msg.type === "presence_leave",
      timeoutMs: 2000,
    });

    leaver.ws.close();

    const messages = await collector;
    const leave = messages.find((m) => m.type === "presence_leave") as Record<string, unknown>;
    expect(leave).toBeDefined();
    expect(leave.userId).toBe("user-2");

    watcher.ws.close();
  });

  it("sandbox event is broadcast to subscribed client", async () => {
    const name = `ws-client-broadcast-${Date.now()}`;
    const { stub } = await initNamedSession(name);

    // Subscribe a client first
    const { ws } = await openClientWs(name, { subscribe: true });

    // Listen for the broadcast
    const collector = collectMessages(ws, {
      until: (msg) =>
        msg.type === "sandbox_event" &&
        (msg.event as Record<string, unknown>)?.type === "tool_call",
      timeoutMs: 2000,
    });

    // Post sandbox event via DO internal endpoint (simulates sandbox behavior)
    await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "tool_call",
        tool: "write_file",
        args: { path: "/src/index.ts" },
        callId: "c-broadcast",
        messageId: "msg-broadcast",
        sandboxId: "sb-1",
        timestamp: Date.now() / 1000,
      }),
    });

    const messages = await collector;
    const broadcast = messages.find(
      (m) =>
        m.type === "sandbox_event" && (m.event as Record<string, unknown>)?.type === "tool_call"
    );
    expect(broadcast).toBeDefined();
    expect((broadcast!.event as Record<string, unknown>).tool).toBe("write_file");

    ws.close();
  });
});
