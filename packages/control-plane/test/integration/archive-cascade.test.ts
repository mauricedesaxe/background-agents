import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { SessionIndexStore } from "../../src/db/session-index";
import type { SessionStatus } from "@open-inspect/shared";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, queryDO } from "./helpers";

/**
 * Exercises the parent→child archive cascade (issue #14) end to end through real
 * SessionDO-to-SessionDO calls in workerd. Archiving a parent must archive its
 * child/sub-task sessions (recursively) so they leave the sidebar, which reads
 * archived status from the D1 session index.
 */
describe("Archive cascade to child sessions", () => {
  beforeEach(cleanD1Tables);

  const uniq = (prefix: string) =>
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  // Seed with an old updated_at so the archive's monotonic D1 write always wins.
  const SEED_TS = 1000;

  // Note: initNamedSession sets the DO's own SQLite status to "created"; the
  // seeded `status` below is the D1 index row (what the sidebar reads). These
  // children carry no live execution — the reconcile-suppression path is covered
  // by the archiveCascade unit tests.
  async function seedSession(
    store: SessionIndexStore,
    id: string,
    opts: { status: SessionStatus; parentSessionId?: string; spawnSource?: "user" | "agent" }
  ) {
    await initNamedSession(id, { userId: "user-1", scmLogin: "acmedev" });
    await store.create({
      id,
      title: id,
      repoOwner: "acme",
      repoName: "web-app",
      model: "anthropic/claude-sonnet-4-6",
      reasoningEffort: null,
      baseBranch: null,
      status: opts.status,
      parentSessionId: opts.parentSessionId ?? null,
      spawnSource: opts.spawnSource ?? (opts.parentSessionId ? "agent" : "user"),
      spawnDepth: opts.parentSessionId ? 1 : 0,
      createdAt: SEED_TS,
      updatedAt: SEED_TS,
    });
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

    await seedSession(store, parent, { status: "active" });
    await seedSession(store, child, { status: "active", parentSessionId: parent });
    await seedSession(store, grandchild, { status: "active", parentSessionId: child });

    await archiveParent(parent);

    // Parent archives synchronously; child + grandchild archive via the cascade.
    await waitForD1Status(store, parent, "archived");
    await waitForD1Status(store, child, "archived");
    await waitForD1Status(store, grandchild, "archived");

    // The child DO's own SQLite status is flipped too, not just the D1 index.
    const childStub = env.SESSION.get(env.SESSION.idFromName(child));
    const rows = await queryDO<{ status: string }>(childStub, "SELECT status FROM session");
    expect(rows[0]?.status).toBe("archived");
  });

  it("archives children regardless of spawn source", async () => {
    const store = new SessionIndexStore(env.DB);
    const parent = uniq("parent");
    const child = uniq("child");

    await seedSession(store, parent, { status: "active" });
    // A child linked by parent_session_id but not agent-spawned still hangs off
    // the parent in the sidebar, so it must be archived too.
    await seedSession(store, child, {
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

    await seedSession(store, parent, { status: "active" });
    await seedSession(store, other, { status: "active" });

    await archiveParent(parent);
    await waitForD1Status(store, parent, "archived");

    expect((await store.get(other))?.status).toBe("active");
  });

  it("skips an already-archived child without error", async () => {
    const store = new SessionIndexStore(env.DB);
    const parent = uniq("parent");
    const child = uniq("child");

    await seedSession(store, parent, { status: "active" });
    await seedSession(store, child, { status: "archived", parentSessionId: parent });

    await archiveParent(parent);
    await waitForD1Status(store, parent, "archived");

    // Still archived, and the parent archive succeeded (asserted in archiveParent).
    expect((await store.get(child))?.status).toBe("archived");
  });

  it("archives a healthy sibling even when another child cannot be archived", async () => {
    const store = new SessionIndexStore(env.DB);
    const parent = uniq("parent");
    const healthy = uniq("healthy");
    const brokenChild = uniq("broken");

    await seedSession(store, parent, { status: "active" });
    await seedSession(store, healthy, { status: "active", parentSessionId: parent });
    // A child indexed in D1 but whose DO was never initialized (e.g. evicted):
    // its archiveCascade is a no-op, and the cascade is best-effort per child.
    await store.create({
      id: brokenChild,
      title: brokenChild,
      repoOwner: "acme",
      repoName: "web-app",
      model: "anthropic/claude-sonnet-4-6",
      reasoningEffort: null,
      baseBranch: null,
      status: "active",
      parentSessionId: parent,
      spawnSource: "agent",
      spawnDepth: 1,
      createdAt: SEED_TS,
      updatedAt: SEED_TS,
    });

    await archiveParent(parent);

    // The parent and the healthy sibling still archive despite the broken child.
    await waitForD1Status(store, parent, "archived");
    await waitForD1Status(store, healthy, "archived");
  });
});
