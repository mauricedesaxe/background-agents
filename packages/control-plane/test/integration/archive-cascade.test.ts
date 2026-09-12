import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { SessionIndexStore } from "../../src/db/session-index";
import { runInSessionDO } from "./session-do-access";
import type { SessionDO } from "../../src/cloudflare/durable-object";
import { cleanD1Tables } from "./cleanup";
import {
  initNamedSession,
  initNamedSessionDO,
  queryDO,
  seedMessage,
  TEST_SESSION_PROVIDER_AUTH,
} from "./helpers";

describe("Archive cascade to child sessions", () => {
  beforeEach(cleanD1Tables);

  const unique = (prefix: string) =>
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  async function archiveParent(sessionName: string): Promise<Response> {
    const id = env.SESSION.idFromName(sessionName);
    const stub = env.SESSION.get(id);
    return stub.fetch("http://internal/internal/archive", { method: "POST" });
  }

  async function doStatus(sessionName: string): Promise<string | undefined> {
    const id = env.SESSION.idFromName(sessionName);
    const stub = env.SESSION.get(id);
    const rows = await queryDO<{ status: string }>(stub, "SELECT status FROM session LIMIT 1");
    return rows[0]?.status;
  }

  async function indexStatus(sessionName: string): Promise<string | undefined> {
    return (await new SessionIndexStore(env.DB).get(sessionName))?.status;
  }

  it("archives an active child and grandchild when the parent is archived", async () => {
    const parent = await initNamedSession(unique("cascade-parent"));
    const child = await initNamedSession(unique("cascade-child"), {
      parentSessionId: parent.sessionName,
    });
    const grandchild = await initNamedSession(unique("cascade-grandchild"), {
      parentSessionId: child.sessionName,
    });

    const res = await archiveParent(parent.sessionName);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "archived" });

    expect(await indexStatus(parent.sessionName)).toBe("archived");
    expect(await indexStatus(child.sessionName)).toBe("archived");
    expect(await indexStatus(grandchild.sessionName)).toBe("archived");

    expect(await doStatus(parent.sessionName)).toBe("archived");
    expect(await doStatus(child.sessionName)).toBe("archived");
    expect(await doStatus(grandchild.sessionName)).toBe("archived");
  });

  it("stops a running child's execution before archiving it", async () => {
    const parent = await initNamedSession(unique("cascade-parent"));
    const child = await initNamedSession(unique("cascade-child"), {
      parentSessionId: parent.sessionName,
    });

    const participants = await queryDO<{ id: string }>(
      child.stub,
      "SELECT id FROM participants WHERE user_id = 'user-1'"
    );
    await seedMessage(child.stub, {
      id: "msg-cascade-wedged",
      authorId: participants[0].id,
      content: "Wedged child prompt",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 1000,
      startedAt: Date.now() - 500,
    });

    const res = await archiveParent(parent.sessionName);

    expect(res.status).toBe(200);
    expect(await indexStatus(child.sessionName)).toBe("archived");
    const messages = await queryDO<{ status: string; error_message: string | null }>(
      child.stub,
      "SELECT status, error_message FROM messages WHERE id = ?",
      "msg-cascade-wedged"
    );
    expect(messages[0].status).toBe("failed");
    expect(messages[0].error_message).toBe("Session was archived");
  });

  it("clears a wedged child's stop fence on alarm recovery and dispatches nothing", async () => {
    // Why: the child's suppressed stop times out only after the transition completes, so recovery must drop the fence without dispatching queued work.
    const parent = await initNamedSession(unique("cascade-parent"));
    const child = await initNamedSession(unique("cascade-child"), {
      parentSessionId: parent.sessionName,
    });

    const participants = await queryDO<{ id: string }>(
      child.stub,
      "SELECT id FROM participants WHERE user_id = 'user-1'"
    );
    await seedMessage(child.stub, {
      id: "msg-cascade-alarm-processing",
      authorId: participants[0].id,
      content: "Wedged child prompt",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 1000,
      startedAt: Date.now() - 500,
    });
    await seedMessage(child.stub, {
      id: "msg-cascade-alarm-queued",
      authorId: participants[0].id,
      content: "Queued child prompt",
      source: "web",
      status: "pending",
      createdAt: Date.now() - 500,
    });

    const res = await archiveParent(parent.sessionName);
    expect(res.status).toBe(200);

    await queryDO(
      child.stub,
      "UPDATE messages SET stop_confirmation_deadline = ? WHERE stop_confirmation_deadline IS NOT NULL",
      Date.now() - 1000
    );

    await runInSessionDO(child.stub, (instance: SessionDO) => instance.alarm());

    const fence = await queryDO<{ count: number }>(
      child.stub,
      "SELECT COUNT(*) as count FROM messages WHERE stop_confirmation_deadline IS NOT NULL"
    );
    expect(fence[0].count).toBe(0);

    const statuses = await queryDO<{ id: string; status: string }>(
      child.stub,
      "SELECT id, status FROM messages WHERE id IN (?, ?)",
      "msg-cascade-alarm-processing",
      "msg-cascade-alarm-queued"
    );
    expect(statuses.find((m) => m.id === "msg-cascade-alarm-queued")?.status).toBe("failed");
    expect(statuses.every((m) => m.status !== "processing")).toBe(true);
    expect(await doStatus(child.sessionName)).toBe("archived");
  });

  it("skips an already-archived child without error", async () => {
    const parent = await initNamedSession(unique("cascade-parent"));
    const child = await initNamedSession(unique("cascade-child"), {
      parentSessionId: parent.sessionName,
    });
    await queryDO(child.stub, "UPDATE session SET status = 'archived'");
    await new SessionIndexStore(env.DB).updateStatus(child.sessionName, "archived", Date.now());

    const res = await archiveParent(parent.sessionName);

    expect(res.status).toBe(200);
    expect(await indexStatus(parent.sessionName)).toBe("archived");
    expect(await indexStatus(child.sessionName)).toBe("archived");
  });

  it("leaves an unrelated top-level session untouched", async () => {
    const parent = await initNamedSession(unique("cascade-parent"));
    const bystander = await initNamedSession(unique("cascade-bystander"));

    const res = await archiveParent(parent.sessionName);

    expect(res.status).toBe(200);
    expect(await indexStatus(bystander.sessionName)).toBe("created");
    expect(await doStatus(bystander.sessionName)).toBe("created");
  });

  it("still archives a sibling when another child's DO was never created", async () => {
    const parent = await initNamedSession(unique("cascade-parent"));
    const ghost = unique("cascade-ghost");
    const now = Date.now();
    await new SessionIndexStore(env.DB).create({
      id: ghost,
      title: "Ghost child",
      repoOwner: "acme",
      repoName: "web-app",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: "main",
      status: "active",
      parentSessionId: parent.sessionName,
      spawnSource: "agent",
      spawnDepth: 1,
      providerAuth: TEST_SESSION_PROVIDER_AUTH,
      createdAt: now,
      updatedAt: now,
    });
    const sibling = await initNamedSession(unique("cascade-sibling"), {
      parentSessionId: parent.sessionName,
    });

    const res = await archiveParent(parent.sessionName);

    expect(res.status).toBe(200);
    expect(await indexStatus(sibling.sessionName)).toBe("archived");
    expect(await doStatus(sibling.sessionName)).toBe("archived");
  });

  it("cascades from the expire-draft entrypoint as well", async () => {
    const parent = await initNamedSession(unique("cascade-parent"));
    const child = await initNamedSession(unique("cascade-child"), {
      parentSessionId: parent.sessionName,
    });

    const id = env.SESSION.idFromName(parent.sessionName);
    const res = await env.SESSION.get(id).fetch("http://internal/internal/expire-draft", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    expect(await indexStatus(parent.sessionName)).toBe("archived");
    expect(await indexStatus(child.sessionName)).toBe("archived");
    expect(await doStatus(child.sessionName)).toBe("archived");
  });

  it("archives the parent when a descendant chain has an uninitialized middle DO", async () => {
    const parent = await initNamedSession(unique("cascade-parent"));
    const missing = unique("cascade-missing");
    const leaf = await initNamedSessionDO(unique("cascade-leaf"), {
      parentSessionId: missing,
    });
    const now = Date.now();
    await new SessionIndexStore(env.DB).create({
      id: missing,
      title: "Missing middle",
      repoOwner: "acme",
      repoName: "web-app",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: "main",
      status: "active",
      parentSessionId: parent.sessionName,
      spawnSource: "agent",
      spawnDepth: 1,
      providerAuth: TEST_SESSION_PROVIDER_AUTH,
      createdAt: now,
      updatedAt: now,
    });
    await new SessionIndexStore(env.DB).create({
      id: leaf.sessionName,
      title: "Leaf",
      repoOwner: "acme",
      repoName: "web-app",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: "main",
      status: "active",
      parentSessionId: missing,
      spawnSource: "agent",
      spawnDepth: 2,
      providerAuth: TEST_SESSION_PROVIDER_AUTH,
      createdAt: now + 1,
      updatedAt: now + 1,
    });

    const res = await archiveParent(parent.sessionName);

    expect(res.status).toBe(200);
    expect(await indexStatus(parent.sessionName)).toBe("archived");
    expect(await doStatus(parent.sessionName)).toBe("archived");
  });
});
