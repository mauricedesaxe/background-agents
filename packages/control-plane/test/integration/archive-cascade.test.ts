import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { SessionIndexStore } from "../../src/db/session-index";
import type { SessionStatus } from "@open-inspect/shared/types/sessions";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, queryDO } from "./helpers";

/**
 * Exercises the parent→child archive cascade end to end through real
 * SessionDO-to-SessionDO calls in workerd. Archiving a parent must archive its
 * child/sub-task sessions (recursively) so they leave the sidebar, which reads
 * archived status from the D1 session index.
 */
describe("Archive cascade to child sessions", () => {
  beforeEach(cleanD1Tables);

  const uniq = (prefix: string) =>
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  async function seedSession(
    id: string,
    opts: {
      status?: SessionStatus;
      parentSessionId?: string;
      spawnSource?: "user" | "agent";
    } = {}
  ) {
    await initNamedSession(id, {
      userId: "user-1",
      scmLogin: "acmedev",
      parentSessionId: opts.parentSessionId,
      spawnSource: opts.spawnSource ?? (opts.parentSessionId ? "agent" : "user"),
      spawnDepth: opts.parentSessionId ? 1 : 0,
    });
    if (opts.status && opts.status !== "created") {
      await new SessionIndexStore(env.DB).updateStatus(id, opts.status, Date.now());
    }
  }

  async function archiveParent(parentId: string) {
    const stub = env.SESSION.get(env.SESSION.idFromName(parentId));
    const res = await stub.fetch("http://internal/internal/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-1" }),
    });
    expect(res.status).toBe(200);
  }

  async function waitForD1Status(
    store: SessionIndexStore,
    id: string,
    expected: SessionStatus,
    timeoutMs = 3000
  ) {
    const deadline = Date.now() + timeoutMs;
    let last: string | undefined;
    while (Date.now() < deadline) {
      last = (await store.get(id))?.status;
      if (last === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for D1 status "${expected}" on ${id}; last was "${last}"`);
  }

  it("cascades archive to a child and grandchild", async () => {
    const store = new SessionIndexStore(env.DB);
    const parent = uniq("parent");
    const child = uniq("child");
    const grandchild = uniq("grandchild");

    await seedSession(parent, { status: "active" });
    await seedSession(child, { status: "active", parentSessionId: parent });
    await seedSession(grandchild, { status: "active", parentSessionId: child });

    await archiveParent(parent);

    await waitForD1Status(store, parent, "archived");
    await waitForD1Status(store, child, "archived");
    await waitForD1Status(store, grandchild, "archived");

    const childStub = env.SESSION.get(env.SESSION.idFromName(child));
    const rows = await queryDO<{ status: string }>(childStub, "SELECT status FROM session");
    expect(rows[0]?.status).toBe("archived");
  });

  it("archives children regardless of spawn source", async () => {
    const store = new SessionIndexStore(env.DB);
    const parent = uniq("parent");
    const child = uniq("child");

    await seedSession(parent, { status: "active" });
    await seedSession(child, {
      status: "completed",
      parentSessionId: parent,
      spawnSource: "user",
    });

    await archiveParent(parent);

    await waitForD1Status(store, child, "archived");
  });

  it("leaves unrelated top-level sessions untouched", async () => {
    const store = new SessionIndexStore(env.DB);
    const parent = uniq("parent");
    const other = uniq("other");

    await seedSession(parent, { status: "active" });
    await seedSession(other, { status: "active" });

    await archiveParent(parent);
    await waitForD1Status(store, parent, "archived");

    expect((await store.get(other))?.status).toBe("active");
  });

  it("skips an already-archived child without error", async () => {
    const store = new SessionIndexStore(env.DB);
    const parent = uniq("parent");
    const child = uniq("child");

    await seedSession(parent, { status: "active" });
    await seedSession(child, { status: "archived", parentSessionId: parent });

    await archiveParent(parent);
    await waitForD1Status(store, parent, "archived");

    expect((await store.get(child))?.status).toBe("archived");
  });

  it("archives a healthy sibling even when another child's DO was never created", async () => {
    const store = new SessionIndexStore(env.DB);
    const parent = uniq("parent");
    const healthy = uniq("healthy");
    const orphanRow = uniq("orphan-row");

    await seedSession(parent, { status: "active" });
    await seedSession(healthy, { status: "active", parentSessionId: parent });
    await store.create({
      id: orphanRow,
      title: orphanRow,
      repoOwner: "acme",
      repoName: "web-app",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: null,
      status: "active",
      parentSessionId: parent,
      spawnSource: "agent",
      spawnDepth: 1,
      userId: "user-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await archiveParent(parent);

    await waitForD1Status(store, parent, "archived");
    await waitForD1Status(store, healthy, "archived");
  });
});
