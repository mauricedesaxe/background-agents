import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import {
  collectMessages,
  initNamedSession,
  openClientWs,
  openSandboxWs,
  seedSandboxAuth,
  seedMessage,
  sendSandboxReady,
  queryDO,
  waitForSandboxStatus,
} from "./helpers";

const SANDBOX_TOKEN = "test-sandbox-auth-token-abc123";
const SANDBOX_ID = "sb-integration-test";

describe("Sandbox WebSocket (via SELF.fetch)", () => {
  it("upgrade with valid auth returns 101", async () => {
    const name = `ws-sandbox-ok-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });

    const { ws, response } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });

    expect(response.status).toBe(101);
    expect(ws).not.toBeNull();
    ws!.accept();
    ws!.close();
  });

  it("upgrade with wrong token returns 401", async () => {
    const name = `ws-sandbox-badtoken-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });

    const { ws, response } = await openSandboxWs(name, {
      authToken: "wrong-token",
      sandboxId: SANDBOX_ID,
    });

    expect(response.status).toBe(401);
    expect(ws).toBeNull();
  });

  it("upgrade with wrong sandbox ID returns 403", async () => {
    const name = `ws-sandbox-badid-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });

    const { ws, response } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: "wrong-sandbox-id",
    });

    expect(response.status).toBe(403);
    expect(ws).toBeNull();
  });

  it("upgrade for stopped sandbox returns 410", async () => {
    const name = `ws-sandbox-stopped-${Date.now()}`;
    const { stub } = await initNamedSession(name);

    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "stopped",
    });

    const { ws, response } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });

    expect(response.status).toBe(410);
    expect(ws).toBeNull();
  });

  it("sandbox remains connecting until the bridge verifies context", async () => {
    const name = `ws-sandbox-ready-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "connecting",
    });
    const { ws } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(ws).not.toBeNull();
    ws!.accept();
    await waitForSandboxStatus(stub, "connecting");
    sendSandboxReady(ws!, SANDBOX_ID, "existing");
    await waitForSandboxStatus(stub, "ready");

    const stateRes = await stub.fetch("http://internal/internal/state");
    const state = await stateRes.json<{ sandbox: { status: string } }>();
    expect(state.sandbox.status).toBe("ready");

    ws!.close();
  });

  it("failed sandbox can reconnect and self-heal to ready", async () => {
    const name = `ws-sandbox-selfheal-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    // The WS upgrade gate deliberately admits "failed" sandboxes: a slow boot
    // that outlived the connecting watchdog recovers here, unlike stopped or
    // stale which are rejected with 410.
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "failed",
    });

    const { ws } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(ws).not.toBeNull();
    ws!.accept();
    sendSandboxReady(ws!, SANDBOX_ID, "restored");
    await waitForSandboxStatus(stub, "ready");
    ws!.close();
  });

  it("fails queued prompts without dispatch when context is unavailable", async () => {
    const name = `ws-sandbox-context-unavailable-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "connecting",
    });
    const participant = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE user_id = 'user-1'"
    );
    await seedMessage(stub, {
      id: "interrupted-message",
      authorId: participant[0].id,
      content: "work interrupted before replacement",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 1000,
      startedAt: Date.now() - 500,
    });
    const { ws: sandboxWs } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    sandboxWs!.accept();
    const { ws: clientWs } = await openClientWs(name, { subscribe: true });
    const queued = collectMessages(clientWs, {
      until: (message) => message.type === "prompt_queued",
    });
    clientWs.send(JSON.stringify({ type: "prompt", content: "continue" }));
    await queued;

    const sandboxMessages = collectMessages(sandboxWs!, {
      until: (message) => message.type === "ack",
    });
    const failed = collectMessages(clientWs, {
      until: (message) =>
        message.type === "sandbox_event" && message.event.type === "execution_complete",
    });
    sandboxWs!.send(
      JSON.stringify({
        type: "context_unavailable",
        sandboxId: SANDBOX_ID,
        opencodeSessionId: "ses_missing",
        error: "The prior OpenCode conversation could not be restored",
        ackId: "context_unavailable:ses_missing",
        timestamp: Date.now() / 1000,
      })
    );

    const controlMessages = await sandboxMessages;
    expect(controlMessages.some((message) => message.type === "prompt")).toBe(false);
    expect(controlMessages).toContainEqual({
      type: "ack",
      ackId: "context_unavailable:ses_missing",
    });
    expect(await failed).toContainEqual({
      type: "sandbox_event",
      event: expect.objectContaining({
        type: "execution_complete",
        success: false,
        error: "The prior OpenCode conversation could not be restored",
      }),
    });
    const messages = await queryDO<{ status: string }>(stub, "SELECT status FROM messages");
    expect(messages).toEqual([{ status: "failed" }, { status: "failed" }]);

    sandboxWs!.close();
    clientWs.close();
  });

  it("refuses fresh readiness when an existing conversation is expected", async () => {
    const name = `ws-sandbox-ready-mismatch-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "connecting",
    });
    await queryDO(stub, "UPDATE session SET opencode_session_id = ?", "ses_expected");
    const { ws: sandboxWs } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    sandboxWs!.accept();
    sendSandboxReady(sandboxWs!, SANDBOX_ID, "fresh");
    await waitForSandboxStatus(stub, "failed");

    const state = await queryDO<{ opencode_session_id: string }>(
      stub,
      "SELECT opencode_session_id FROM session"
    );
    expect(state).toEqual([{ opencode_session_id: "ses_expected" }]);
    const events = await queryDO<{ type: string }>(
      stub,
      "SELECT type FROM events WHERE type = 'context_unavailable'"
    );
    expect(events).toEqual([{ type: "context_unavailable" }]);

    sandboxWs!.close();
  });

  it("sandbox WS message is stored as event", async () => {
    const name = `ws-sandbox-event-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });

    const { ws } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(ws).not.toBeNull();
    ws!.accept();

    // Send a token event via the sandbox WebSocket
    ws!.send(
      JSON.stringify({
        type: "tool_call",
        tool: "read_file",
        args: { path: "/src/main.ts" },
        callId: "call-ws-1",
        messageId: "msg-ws-1",
        sandboxId: SANDBOX_ID,
        timestamp: Date.now() / 1000,
      })
    );

    // Allow time for the DO to process the message
    await new Promise((r) => setTimeout(r, 200));

    const events = await queryDO<{ type: string; data: string }>(
      stub,
      "SELECT type, data FROM events WHERE type = ?",
      "tool_call"
    );

    const matching = events.filter((e) => {
      const data = JSON.parse(e.data);
      return data.callId === "call-ws-1";
    });
    expect(matching.length).toBeGreaterThanOrEqual(1);

    ws!.close();
  });

  it("accepts step_finish messages with structured token usage", async () => {
    const name = `ws-sandbox-step-finish-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await env.DB.prepare(
      `INSERT INTO sessions (id, total_cost, usage_cost_baseline, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(name, 0.5, 0.5, Date.now(), Date.now())
      .run();
    const { ws: clientWs } = await openClientWs(name, { subscribe: true });
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });

    const { ws: sandboxWs } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(sandboxWs).not.toBeNull();
    sandboxWs!.accept();
    sendSandboxReady(sandboxWs!, SANDBOX_ID);
    await waitForSandboxStatus(stub, "ready");

    const tokenUsage = {
      total: 223,
      input: 219,
      output: 4,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    };
    const stepObservedAt = Date.now() - 60_000;
    const collector = collectMessages(clientWs, {
      until: (msg) =>
        msg.type === "sandbox_event" &&
        (msg.event as Record<string, unknown> | undefined)?.type === "step_finish",
    });
    const firstAckCollector = collectMessages(sandboxWs!, {
      until: (msg) => msg.type === "ack" && msg.ackId === "step_finish:step-1",
    });

    sandboxWs!.send(
      JSON.stringify({
        type: "step_finish",
        messageId: "msg-step-finish-1",
        stepId: "step-1",
        ackId: "step_finish:step-1",
        cost: 0.001,
        tokens: tokenUsage,
        reason: "end_turn",
        sandboxId: SANDBOX_ID,
        timestamp: stepObservedAt / 1000,
      })
    );

    const [messages, firstAcknowledgements] = await Promise.all([collector, firstAckCollector]);
    expect(firstAcknowledgements).toContainEqual({
      type: "ack",
      ackId: "step_finish:step-1",
    });
    const stepFinish = messages.find(
      (msg) =>
        msg.type === "sandbox_event" &&
        (msg.event as Record<string, unknown> | undefined)?.type === "step_finish"
    );

    expect(stepFinish).toBeDefined();
    expect((stepFinish!.event as { tokens: unknown }).tokens).toEqual(tokenUsage);
    expect((stepFinish!.event as { stepId: unknown }).stepId).toBe("step-1");

    const ackCollector = collectMessages(sandboxWs!, {
      until: (msg) => msg.type === "ack" && msg.ackId === "step_finish:step-1",
    });
    sandboxWs!.send(
      JSON.stringify({
        type: "step_finish",
        messageId: "msg-step-finish-1",
        stepId: "step-1",
        ackId: "step_finish:step-1",
        cost: 0.001,
        tokens: tokenUsage,
        reason: "end_turn",
        sandboxId: SANDBOX_ID,
        timestamp: Date.now(),
      })
    );
    const acknowledgements = await ackCollector;
    expect(acknowledgements).toContainEqual({ type: "ack", ackId: "step_finish:step-1" });

    const facts = await env.DB.prepare(
      `SELECT observed_at, cost_estimate, total_tokens, input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens
       FROM session_usage_facts WHERE event_id = ?`
    )
      .bind("step-1")
      .all();
    expect(facts.results).toEqual([
      {
        observed_at: stepObservedAt,
        cost_estimate: 0.001,
        total_tokens: 223,
        input_tokens: 219,
        output_tokens: 4,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      },
    ]);

    const totals = await env.DB.prepare(
      `SELECT total_cost, total_tokens, input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens
       FROM sessions WHERE id = ?`
    )
      .bind(name)
      .first();
    expect(totals).toEqual({
      total_cost: 0.501,
      total_tokens: 223,
      input_tokens: 219,
      output_tokens: 4,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    });

    sandboxWs!.close();
    clientWs.close();
  });
});
