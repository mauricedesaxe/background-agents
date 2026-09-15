import { describe, it, expect, vi, type MockInstance } from "vitest";
import { env } from "cloudflare:test";
import { initSession, queryDO, seedMessage, waitForSandboxStatus } from "./helpers";
import type { SessionDO } from "../../src/cloudflare/durable-object";
import { componentsOf, runInSessionDO } from "./session-do-access";

describe("POST /internal/sandbox-event", () => {
  it("stores token event", async () => {
    const { stub } = await initSession();

    const res = await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "token",
        content: "hello",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: Date.now() / 1000,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json<{ status: string }>();
    expect(body.status).toBe("ok");

    const events = await queryDO<{ type: string; data: string }>(
      stub,
      "SELECT type, data FROM events WHERE type = 'token'"
    );

    const tokenEvents = events.filter((e) => {
      const data = JSON.parse(e.data);
      return data.content === "hello";
    });
    expect(tokenEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("stores tool_call with messageId", async () => {
    const { stub } = await initSession();

    // Enqueue a prompt to get a real messageId
    const promptRes = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Read file", authorId: "user-1", source: "web" }),
    });
    const { messageId } = await promptRes.json<{ messageId: string }>();

    const res = await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "tool_call",
        tool: "read_file",
        args: { path: "/src/index.ts" },
        callId: "c1",
        messageId,
        sandboxId: "sb-1",
        timestamp: Date.now() / 1000,
      }),
    });

    expect(res.status).toBe(200);

    const events = await queryDO<{ type: string; message_id: string }>(
      stub,
      "SELECT type, message_id FROM events WHERE type = 'tool_call'"
    );

    const matching = events.filter((e) => e.message_id === messageId);
    expect(matching.length).toBeGreaterThanOrEqual(1);
  });

  it("updates a tool snapshot without moving its timeline position", async () => {
    const { stub } = await initSession();
    const promptResponse = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Review code", authorId: "user-1", source: "web" }),
    });
    const { messageId } = await promptResponse.json<{ messageId: string }>();

    const sendToolSnapshot = async (status: string, timestamp: number) => {
      const response = await stub.fetch("http://internal/internal/sandbox-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "tool_call",
          tool: "task",
          args: { description: "Review code" },
          callId: "task-call-1",
          status,
          messageId,
          sandboxId: "sb-1",
          timestamp,
        }),
      });
      expect(response.status).toBe(200);
    };

    await sendToolSnapshot("running", 1000);
    const runningEvents = await queryDO<{ created_at: number }>(
      stub,
      `SELECT created_at FROM events
       WHERE type = 'tool_call' AND message_id = ?`,
      messageId
    );
    await sendToolSnapshot("completed", 2000);

    const events = await queryDO<{ data: string; created_at: number }>(
      stub,
      `SELECT data, created_at FROM events
       WHERE type = 'tool_call' AND message_id = ?`,
      messageId
    );

    expect(events).toHaveLength(1);
    expect(events[0].created_at).toBe(runningEvents[0].created_at);
    expect(JSON.parse(events[0].data)).toMatchObject({ status: "completed", timestamp: 2000 });
  });

  it("stores artifact events in both artifacts and events tables", async () => {
    const { stub } = await initSession();

    const res = await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "artifact",
        artifactType: "screenshot",
        url: "sessions/session-1/media/artifact-1.png",
        metadata: {
          objectKey: "sessions/session-1/media/artifact-1.png",
          mimeType: "image/png",
          sizeBytes: 256,
        },
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: Date.now() / 1000,
      }),
    });

    expect(res.status).toBe(200);

    const artifacts = await queryDO<{ type: string; url: string; metadata: string }>(
      stub,
      "SELECT type, url, metadata FROM artifacts WHERE type = 'screenshot'"
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].url).toBe("sessions/session-1/media/artifact-1.png");
    expect(JSON.parse(artifacts[0].metadata)).toMatchObject({
      objectKey: "sessions/session-1/media/artifact-1.png",
      mimeType: "image/png",
      sizeBytes: 256,
    });

    const events = await queryDO<{ type: string; message_id: string; data: string }>(
      stub,
      "SELECT type, message_id, data FROM events WHERE type = 'artifact'"
    );
    expect(events).toHaveLength(1);
    expect(events[0].message_id).toBe("msg-1");
    expect(JSON.parse(events[0].data)).toMatchObject({
      artifactType: "screenshot",
      artifactId: expect.any(String),
      messageId: "msg-1",
      url: "sessions/session-1/media/artifact-1.png",
    });
  });

  it("heartbeat counts as activity only while a message is processing", async () => {
    const { stub } = await initSession();
    const previousActivity = 123;
    await runInSessionDO(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE sandbox SET last_activity = ?", previousActivity);
    });

    const idleHeartbeat = await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "heartbeat",
        sandboxId: "sb-1",
        status: "running",
        timestamp: Date.now() / 1000,
      }),
    });

    expect(idleHeartbeat.status).toBe(200);

    const idleSandbox = await queryDO<{ last_heartbeat: number; last_activity: number }>(
      stub,
      "SELECT last_heartbeat, last_activity FROM sandbox"
    );
    expect(idleSandbox[0].last_heartbeat).toEqual(expect.any(Number));
    expect(idleSandbox[0].last_activity).toBe(previousActivity);

    const participants = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE user_id = 'user-1'"
    );
    await seedMessage(stub, {
      id: "msg-processing",
      authorId: participants[0].id,
      content: "Run a long build",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 1000,
      startedAt: Date.now() - 500,
    });

    const processingHeartbeat = await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "heartbeat",
        sandboxId: "sb-1",
        status: "running",
        timestamp: Date.now() / 1000,
      }),
    });

    expect(processingHeartbeat.status).toBe(200);
    const processingSandbox = await queryDO<{ last_heartbeat: number; last_activity: number }>(
      stub,
      "SELECT last_heartbeat, last_activity FROM sandbox"
    );
    expect(processingSandbox[0].last_activity).toBe(processingSandbox[0].last_heartbeat);
    expect(processingSandbox[0].last_activity).toBeGreaterThan(previousActivity);

    // Heartbeats should NOT be stored as events
    const events = await queryDO<{ type: string }>(
      stub,
      "SELECT type FROM events WHERE type = 'heartbeat'"
    );
    expect(events).toHaveLength(0);
  });

  it("applies generated session title without storing a timeline event", async () => {
    const { stub } = await initSession();

    const res = await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "session_title",
        title: "Generated title",
        sandboxId: "sb-1",
        timestamp: Date.now() / 1000,
      }),
    });

    expect(res.status).toBe(200);

    const stateRes = await stub.fetch("http://internal/internal/state");
    const state = (await stateRes.json()) as { title: string };
    expect(state.title).toBe("Generated title");

    const events = await queryDO<{ type: string }>(
      stub,
      "SELECT type FROM events WHERE type = 'session_title'"
    );
    expect(events).toHaveLength(0);
  });

  it("does not overwrite an existing title with a generated session title", async () => {
    const { stub } = await initSession({ title: "Manual title" });

    const res = await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "session_title",
        title: "Generated title",
        sandboxId: "sb-1",
        timestamp: Date.now() / 1000,
      }),
    });

    expect(res.status).toBe(200);

    const stateRes = await stub.fetch("http://internal/internal/state");
    const state = (await stateRes.json()) as { title: string };
    expect(state.title).toBe("Manual title");
  });

  it("execution_complete marks message as completed", async () => {
    const { stub } = await initSession();

    // Get the participant ID for the owner
    const participants = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE user_id = 'user-1'"
    );
    const participantId = participants[0].id;

    // Seed a message in "processing" state
    const msgId = "msg-complete-test";
    await seedMessage(stub, {
      id: msgId,
      authorId: participantId,
      content: "Test prompt",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 1000,
      startedAt: Date.now() - 500,
    });

    const res = await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "execution_complete",
        messageId: msgId,
        success: true,
        sandboxId: "sb-1",
        timestamp: Date.now() / 1000,
      }),
    });

    expect(res.status).toBe(200);

    const messages = await queryDO<{ status: string; completed_at: number | null }>(
      stub,
      `SELECT status, completed_at FROM messages WHERE id = ?`,
      msgId
    );
    expect(messages[0].status).toBe("completed");
    expect(messages[0].completed_at).toEqual(expect.any(Number));

    const sessions = await queryDO<{ status: string }>(stub, "SELECT status FROM session LIMIT 1");
    expect(sessions[0].status).toBe("completed");
  });

  it("execution_complete with success=false marks message as failed", async () => {
    const { stub } = await initSession();

    const participants = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE user_id = 'user-1'"
    );
    const participantId = participants[0].id;

    const msgId = "msg-fail-test";
    await seedMessage(stub, {
      id: msgId,
      authorId: participantId,
      content: "Failing prompt",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 1000,
      startedAt: Date.now() - 500,
    });

    await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "execution_complete",
        messageId: msgId,
        success: false,
        error: "Sandbox crashed",
        sandboxId: "sb-1",
        timestamp: Date.now() / 1000,
      }),
    });

    const messages = await queryDO<{ status: string }>(
      stub,
      `SELECT status FROM messages WHERE id = ?`,
      msgId
    );
    expect(messages[0].status).toBe("failed");

    const sessions = await queryDO<{ status: string }>(stub, "SELECT status FROM session LIMIT 1");
    expect(sessions[0].status).toBe("failed");
  });

  it("execution_complete keeps session active when queued messages remain", async () => {
    const { stub } = await initSession();

    const participants = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE user_id = 'user-1'"
    );
    const participantId = participants[0].id;

    const processingMsgId = "msg-processing";
    await seedMessage(stub, {
      id: processingMsgId,
      authorId: participantId,
      content: "First prompt",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 2000,
      startedAt: Date.now() - 1000,
    });

    const queuedMsgId = "msg-queued";
    await seedMessage(stub, {
      id: queuedMsgId,
      authorId: participantId,
      content: "Second prompt",
      source: "web",
      status: "pending",
      createdAt: Date.now() - 500,
    });

    const res = await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "execution_complete",
        messageId: processingMsgId,
        success: true,
        sandboxId: "sb-1",
        timestamp: Date.now() / 1000,
      }),
    });

    expect(res.status).toBe(200);

    const sessions = await queryDO<{ status: string }>(stub, "SELECT status FROM session LIMIT 1");
    expect(sessions[0].status).toBe("active");
  });

  it("git_sync updates sandbox and session", async () => {
    const { stub } = await initSession();

    const res = await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "git_sync",
        status: "completed",
        sha: "abc123def456",
        sandboxId: "sb-1",
        timestamp: Date.now() / 1000,
      }),
    });

    expect(res.status).toBe(200);

    const sandbox = await queryDO<{ git_sync_status: string }>(
      stub,
      "SELECT git_sync_status FROM sandbox"
    );
    expect(sandbox[0].git_sync_status).toBe("completed");

    const session = await queryDO<{ current_sha: string }>(stub, "SELECT current_sha FROM session");
    expect(session[0].current_sha).toBe("abc123def456");
  });

  it("multiple token events upsert to latest persisted event", async () => {
    const { stub } = await initSession();
    const now = Date.now() / 1000;

    // Send 3 token events for the same message
    for (let i = 0; i < 3; i++) {
      await stub.fetch("http://internal/internal/sandbox-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "token",
          content: `token-${i}`,
          messageId: "msg-order",
          sandboxId: "sb-1",
          timestamp: now + i,
        }),
      });
    }

    const eventsRes = await stub.fetch(
      "http://internal/internal/events?type=token&message_id=msg-order"
    );
    const { events } = await eventsRes.json<{
      events: Array<{
        id: string;
        type: string;
        data: { content: string };
        messageId: string;
        createdAt: number;
      }>;
    }>();

    expect(events).toHaveLength(1);
    expect(events[0].id).toBe("token:msg-order");
    expect(events[0].messageId).toBe("msg-order");
    expect(events[0].data.content).toBe("token-2");
  });

  it("a divergent ready stores a context_reset and holds the queued prompt", async () => {
    const { stub } = await initSession();
    await queryDO(stub, `UPDATE session SET agent_session_id = 'ses-stored'`);

    const participants = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE user_id = 'user-1'"
    );
    await seedMessage(stub, {
      id: "msg-held-live",
      authorId: participants[0].id,
      content: "Next turn",
      source: "web",
      status: "pending",
      createdAt: Date.now(),
    });

    const res = await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "ready",
        sandboxId: "sb-1",
        opencodeSessionId: null,
        timestamp: Date.now() / 1000,
      }),
    });
    expect(res.status).toBe(200);

    const rows = await queryDO<{ context_reset_hold: number; status: string }>(
      stub,
      "SELECT context_reset_hold, status FROM messages WHERE id = 'msg-held-live'"
    );
    expect(rows[0]).toEqual({ context_reset_hold: 1, status: "pending" });

    const resets = await queryDO<{ data: string }>(
      stub,
      "SELECT data FROM events WHERE type = 'context_reset'"
    );
    expect(JSON.parse(resets[0].data)).toMatchObject({ reason: "fresh_session" });

    const acknowledge = await stub.fetch("http://internal/internal/acknowledge-context-reset", {
      method: "POST",
    });
    expect(acknowledge.status).toBe(200);

    const released = await queryDO<{ context_reset_hold: number }>(
      stub,
      "SELECT context_reset_hold FROM messages WHERE id = 'msg-held-live'"
    );
    expect(released[0].context_reset_hold).toBe(0);
  });

  it("a ready that resumed the stored session id does not hold the queued prompt", async () => {
    const { stub } = await initSession();
    await queryDO(stub, `UPDATE session SET agent_session_id = 'ses-stored'`);

    const participants = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE user_id = 'user-1'"
    );
    await seedMessage(stub, {
      id: "msg-clean-live",
      authorId: participants[0].id,
      content: "Next turn",
      source: "web",
      status: "pending",
      createdAt: Date.now(),
    });

    const res = await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "ready",
        sandboxId: "sb-1",
        opencodeSessionId: "ses-stored",
        resumed: true,
        timestamp: Date.now() / 1000,
      }),
    });
    expect(res.status).toBe(200);

    const rows = await queryDO<{ context_reset_hold: number }>(
      stub,
      "SELECT context_reset_hold FROM messages WHERE id = 'msg-clean-live'"
    );
    expect(rows[0].context_reset_hold).toBe(0);
  });

  it("persists the vendor id a ready reports, and a later divergent ready holds through it", async () => {
    const { stub } = await initSession();

    const first = await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "ready",
        sandboxId: "sb-1",
        opencodeSessionId: "ses-live-1",
        resumed: true,
        timestamp: Date.now() / 1000,
      }),
    });
    expect(first.status).toBe(200);

    const stored = await queryDO<{ agent_session_id: string | null }>(
      stub,
      "SELECT agent_session_id FROM session LIMIT 1"
    );
    expect(stored[0].agent_session_id).toBe("ses-live-1");

    const participants = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE user_id = 'user-1'"
    );
    await seedMessage(stub, {
      id: "msg-held-by-write",
      authorId: participants[0].id,
      content: "Next turn",
      source: "web",
      status: "pending",
      createdAt: Date.now(),
    });

    const divergent = await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "ready",
        sandboxId: "sb-1",
        opencodeSessionId: null,
        timestamp: Date.now() / 1000,
      }),
    });
    expect(divergent.status).toBe(200);

    const rows = await queryDO<{ context_reset_hold: number; status: string }>(
      stub,
      "SELECT context_reset_hold, status FROM messages WHERE id = 'msg-held-by-write'"
    );
    expect(rows[0]).toEqual({ context_reset_hold: 1, status: "pending" });

    const resets = await queryDO<{ data: string }>(
      stub,
      "SELECT data FROM events WHERE type = 'context_reset'"
    );
    expect(JSON.parse(resets[0].data)).toMatchObject({ reason: "fresh_session" });
  });

  it("holds a prompt enqueued after the reset until acknowledge", async () => {
    const { stub } = await initSession();
    await queryDO(stub, `UPDATE session SET agent_session_id = 'ses-stored'`);

    const ready = await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "ready",
        sandboxId: "sb-1",
        opencodeSessionId: null,
        timestamp: Date.now() / 1000,
      }),
    });
    expect(ready.status).toBe(200);

    const prompt = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "After the reset", authorId: "user-1", source: "web" }),
    });
    expect(prompt.status).toBe(200);

    const queued = await queryDO<{ status: string }>(
      stub,
      "SELECT status FROM messages WHERE content = 'After the reset'"
    );
    expect(queued[0].status).toBe("pending");
    const flagged = await queryDO<{ context_reset_pending: number }>(
      stub,
      "SELECT context_reset_pending FROM session LIMIT 1"
    );
    expect(flagged[0].context_reset_pending).toBe(1);

    const acknowledge = await stub.fetch("http://internal/internal/acknowledge-context-reset", {
      method: "POST",
    });
    expect(acknowledge.status).toBe(200);

    const flaggedAfter = await queryDO<{ context_reset_pending: number }>(
      stub,
      "SELECT context_reset_pending FROM session LIMIT 1"
    );
    expect(flaggedAfter[0].context_reset_pending).toBe(0);
  });

  it("auto-releases the context-reset hold when its deadline passes", async () => {
    const { stub } = await initSession();
    await queryDO(stub, `UPDATE session SET agent_session_id = 'ses-stored'`);

    const participants = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE user_id = 'user-1'"
    );
    await seedMessage(stub, {
      id: "msg-auto-release",
      authorId: participants[0].id,
      content: "Stuck behind the reset",
      source: "web",
      status: "pending",
      createdAt: Date.now(),
    });

    const ready = await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "ready",
        sandboxId: "sb-1",
        opencodeSessionId: null,
        timestamp: Date.now() / 1000,
      }),
    });
    expect(ready.status).toBe(200);

    const held = await queryDO<{
      context_reset_pending: number;
      context_reset_hold_deadline: number | null;
    }>(stub, "SELECT context_reset_pending, context_reset_hold_deadline FROM session LIMIT 1");
    expect(held[0].context_reset_pending).toBe(1);
    expect(held[0].context_reset_hold_deadline).toEqual(expect.any(Number));

    await queryDO(stub, `UPDATE session SET context_reset_hold_deadline = ?`, Date.now() - 1000);
    await runInSessionDO(stub, (instance: SessionDO) => instance.alarm());

    const released = await queryDO<{
      context_reset_pending: number;
      context_reset_hold_deadline: number | null;
    }>(stub, "SELECT context_reset_pending, context_reset_hold_deadline FROM session LIMIT 1");
    expect(released[0]).toEqual({ context_reset_pending: 0, context_reset_hold_deadline: null });

    const warnings = await queryDO<{ data: string }>(
      stub,
      "SELECT data FROM events WHERE type = 'warning' ORDER BY created_at DESC LIMIT 1"
    );
    expect(JSON.parse(warnings[0].data)).toMatchObject({ scope: "context" });

    const acknowledge = await stub.fetch("http://internal/internal/acknowledge-context-reset", {
      method: "POST",
    });
    expect(acknowledge.status).toBe(409);
  });

  it("re-arms a hold whose alarm was lost, so activation releases it and drains the queue", async () => {
    const sessionName = `hold-rehydrate-${Date.now()}`;
    const { stub } = await initSession({ sessionName });
    await waitForSandboxStatus(stub, "failed");

    const participants = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE user_id = 'user-1'"
    );
    await seedMessage(stub, {
      id: "msg-hold-rehydrate",
      authorId: participants[0].id,
      content: "Stuck behind a hold that lost its alarm",
      source: "web",
      status: "pending",
      createdAt: Date.now(),
    });
    await queryDO(
      stub,
      "UPDATE session SET context_reset_pending = 1, context_reset_hold_deadline = ?",
      Date.now() - 1000
    );
    await queryDO(
      stub,
      "UPDATE messages SET context_reset_hold = 1 WHERE id = 'msg-hold-rehydrate'"
    );

    await expect(
      runInSessionDO(stub, (_instance: SessionDO, state) => {
        state.abort("test: force eviction");
      })
    ).rejects.toThrow();
    const restored = env.SESSION.get(env.SESSION.idFromName(sessionName));

    let drain: MockInstance | undefined;
    await runInSessionDO(restored, (instance: SessionDO) => {
      drain = vi.spyOn(componentsOf(instance).messageQueue, "processMessageQueue");
    });

    await vi.waitFor(async () => {
      const [released] = await queryDO<{ context_reset_pending: number }>(
        restored,
        "SELECT context_reset_pending FROM session LIMIT 1"
      );
      expect(released?.context_reset_pending).toBe(0);
    });

    const [message] = await queryDO<{ context_reset_hold: number }>(
      restored,
      "SELECT context_reset_hold FROM messages WHERE id = 'msg-hold-rehydrate'"
    );
    expect(message.context_reset_hold).toBe(0);
    expect(drain).toHaveBeenCalled();
  });
});
