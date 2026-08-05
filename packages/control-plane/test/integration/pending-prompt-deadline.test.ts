import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { DEFAULT_CONNECTING_TIMEOUT_CONFIG } from "../../src/sandbox/lifecycle/decisions";
import { PENDING_SANDBOX_CONNECT_TIMEOUT_MS } from "../../src/session/message-queue";
import type { SessionDO } from "../../src/session/durable-object";
import { cleanD1Tables } from "./cleanup";
import {
  collectMessages,
  initNamedSession,
  openClientWs,
  openSandboxWs,
  queryDO,
  seedSandboxAuth,
  sendSandboxReady,
  waitForSandboxStatus,
} from "./helpers";

const SANDBOX_TOKEN = "pending-deadline-sandbox-token";
const SANDBOX_ID = "pending-deadline-sandbox";
const TEST_DEADLINE_MARGIN_MS = 2_000;
const UNRELATED_ALARM_DELAY_MS = 100;
const DEADLINE_SETTLE_DELAY_MS = 20;

beforeEach(cleanD1Tables);
afterEach(cleanD1Tables);

describe("pending prompt connection deadline", () => {
  it("rearms after the connection alarm and fails durably without late dispatch", async () => {
    const name = `pending-deadline-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "connecting",
    });

    const promptResponse = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "This prompt must terminate if readiness never arrives",
        authorId: "user-1",
        source: "web",
      }),
    });
    const { messageId } = await promptResponse.json<{ messageId: string }>();
    const createdAt = Date.now() - PENDING_SANDBOX_CONNECT_TIMEOUT_MS + TEST_DEADLINE_MARGIN_MS;
    const deadlineAt = createdAt + PENDING_SANDBOX_CONNECT_TIMEOUT_MS;
    await queryDO(
      stub,
      "UPDATE messages SET created_at = ?, connect_started_at = ? WHERE id = ?",
      createdAt,
      createdAt,
      messageId
    );
    await queryDO(
      stub,
      `UPDATE sandbox
            SET created_at = ?, last_spawn_error = NULL, last_spawn_error_at = NULL
          WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
      Date.now() - DEFAULT_CONNECTING_TIMEOUT_CONFIG.timeoutMs
    );

    await runInDurableObject(stub, async (_instance: SessionDO, state) => {
      await state.storage.setAlarm(Date.now() + UNRELATED_ALARM_DELAY_MS);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(
      await queryDO<{ status: string }>(stub, "SELECT status FROM messages WHERE id = ?", messageId)
    ).toEqual([{ status: "pending" }]);
    await waitForSandboxStatus(stub, "failed");
    expect(
      await runInDurableObject(stub, (_instance: SessionDO, state) => state.storage.getAlarm())
    ).toBe(deadlineAt);

    const { ws: clientWs } = await openClientWs(name, { subscribe: true });
    const terminalEvent = collectMessages(clientWs, {
      until: (message) =>
        message.type === "sandbox_event" &&
        (message.event as { type?: string } | undefined)?.type === "execution_complete",
    });
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, deadlineAt - Date.now()) + DEADLINE_SETTLE_DELAY_MS)
    );
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(await terminalEvent).toContainEqual({
      type: "sandbox_event",
      event: expect.objectContaining({
        type: "execution_complete",
        messageId,
        success: false,
        error: "Sandbox failed to start (timed out waiting to connect)",
      }),
    });
    expect(
      await queryDO<{ status: string; completed_at: number | null }>(
        stub,
        "SELECT status, completed_at FROM messages WHERE id = ?",
        messageId
      )
    ).toEqual([{ status: "failed", completed_at: expect.any(Number) }]);
    const durableEvents = await queryDO<{ data: string }>(
      stub,
      "SELECT data FROM events WHERE type = 'execution_complete' AND message_id = ?",
      messageId
    );
    expect(durableEvents).toHaveLength(1);
    expect(JSON.parse(durableEvents[0].data)).toEqual(
      expect.objectContaining({ messageId, success: false })
    );

    const replayClient = await openClientWs(name, { subscribe: true });
    const subscribed = replayClient.messages!.find((message) => message.type === "subscribed") as {
      replay: { events: Array<Record<string, unknown>> };
    };
    expect(subscribed.replay.events).toContainEqual(
      expect.objectContaining({
        type: "execution_complete",
        messageId,
        success: false,
        error: "Sandbox failed to start (timed out waiting to connect)",
      })
    );

    const { ws: sandboxWs } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    sandboxWs!.accept();
    const lateSandboxMessages = collectMessages(sandboxWs!, { timeoutMs: 300 });
    sendSandboxReady(sandboxWs!, SANDBOX_ID);
    await waitForSandboxStatus(stub, "ready");
    expect((await lateSandboxMessages).filter((message) => message.type === "prompt")).toEqual([]);

    sandboxWs!.close();
    replayClient.ws.close();
    clientWs.close();
  }, 10_000);

  it("arms the next persisted deadline after failing the oldest pending prompt", async () => {
    const name = `pending-multiple-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "connecting",
    });

    const firstResponse = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "First pending prompt", authorId: "user-1", source: "web" }),
    });
    const { messageId: firstMessageId } = await firstResponse.json<{ messageId: string }>();
    const secondResponse = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Second pending prompt", authorId: "user-1", source: "web" }),
    });
    const { messageId: secondMessageId } = await secondResponse.json<{ messageId: string }>();

    const firstCreatedAt = Date.now() - PENDING_SANDBOX_CONNECT_TIMEOUT_MS;
    const secondCreatedAt =
      Date.now() - PENDING_SANDBOX_CONNECT_TIMEOUT_MS + TEST_DEADLINE_MARGIN_MS;
    const secondDeadlineAt = secondCreatedAt + PENDING_SANDBOX_CONNECT_TIMEOUT_MS;
    await queryDO(
      stub,
      `UPDATE messages
          SET created_at = CASE id WHEN ? THEN ? WHEN ? THEN ? END,
              connect_started_at = CASE id WHEN ? THEN ? WHEN ? THEN ? END
        WHERE id IN (?, ?)`,
      firstMessageId,
      firstCreatedAt,
      secondMessageId,
      secondCreatedAt,
      firstMessageId,
      firstCreatedAt,
      secondMessageId,
      secondCreatedAt,
      firstMessageId,
      secondMessageId
    );
    await queryDO(
      stub,
      `UPDATE sandbox
          SET status = 'failed', last_spawn_error = NULL, last_spawn_error_at = NULL
        WHERE id = (SELECT id FROM sandbox LIMIT 1)`
    );
    await runInDurableObject(stub, async (_instance: SessionDO, state) => {
      await state.storage.setAlarm(Date.now() + UNRELATED_ALARM_DELAY_MS);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(
      await queryDO<{ id: string; status: string }>(
        stub,
        "SELECT id, status FROM messages WHERE id IN (?, ?) ORDER BY created_at",
        firstMessageId,
        secondMessageId
      )
    ).toEqual([
      { id: firstMessageId, status: "failed" },
      { id: secondMessageId, status: "pending" },
    ]);
    expect(
      await runInDurableObject(stub, (_instance: SessionDO, state) => state.storage.getAlarm())
    ).toBe(secondDeadlineAt);

    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, secondDeadlineAt - Date.now()) + DEADLINE_SETTLE_DELAY_MS)
    );
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(
      await queryDO<{ id: string; status: string }>(
        stub,
        "SELECT id, status FROM messages WHERE id IN (?, ?) ORDER BY created_at",
        firstMessageId,
        secondMessageId
      )
    ).toEqual([
      { id: firstMessageId, status: "failed" },
      { id: secondMessageId, status: "failed" },
    ]);
    expect(
      await queryDO<{ count: number }>(
        stub,
        "SELECT COUNT(*) AS count FROM events WHERE type = 'execution_complete' AND message_id IN (?, ?)",
        firstMessageId,
        secondMessageId
      )
    ).toEqual([{ count: 2 }]);
  }, 10_000);

  it("dispatches exactly once when readiness arrives before the deadline", async () => {
    const name = `pending-ready-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "connecting",
    });

    const promptResponse = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Dispatch once after readiness",
        authorId: "user-1",
        source: "web",
      }),
    });
    const { messageId } = await promptResponse.json<{ messageId: string }>();

    const { ws: sandboxWs } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    sandboxWs!.accept();
    const sandboxMessages = collectMessages(sandboxWs!, { timeoutMs: 500 });
    sendSandboxReady(sandboxWs!, SANDBOX_ID);
    await waitForSandboxStatus(stub, "ready");
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const prompts = (await sandboxMessages).filter((message) => message.type === "prompt");
    expect(prompts).toEqual([expect.objectContaining({ type: "prompt", messageId })]);
    expect(
      await queryDO<{ status: string }>(stub, "SELECT status FROM messages WHERE id = ?", messageId)
    ).toEqual([{ status: "processing" }]);

    sandboxWs!.close();
  });
});
