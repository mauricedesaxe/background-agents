import { describe, it, expect, beforeEach, vi } from "vitest";
import { SELF, env } from "cloudflare:test";
import { ParentSessionSpawnRejectedError, SessionIndexStore } from "../../src/db/session-index";
import { buildSessionInternalUrl, SessionInternalPaths } from "../../src/session/contracts";
import { cleanD1Tables } from "./cleanup";
import {
  initNamedSession,
  seedSandboxAuth,
  queryDO,
  seedEvents,
  openClientWs,
  collectMessages,
} from "./helpers";

describe("Child session operations (list, get, cancel)", () => {
  beforeEach(cleanD1Tables);

  const parentName = () => `parent-ops-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  /**
   * Helper to set up a parent+child pair.
   * Creates both DOs (via initNamedSession) and D1 rows.
   */
  async function setupParentAndChild(opts?: { childStatus?: string }) {
    const pName = parentName();
    const childName = `child-ops-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Create parent DO
    const { stub: parentStub } = await initNamedSession(pName, {
      repoOwner: "acme",
      repoName: "web-app",
      userId: "user-1",
      scmLogin: "acmedev",
    });

    // Seed sandbox auth on parent so sandbox Bearer token works
    const sandboxToken = `sb-tok-ops-${Date.now()}`;
    await seedSandboxAuth(parentStub, { authToken: sandboxToken, sandboxId: "sb-ops-1" });

    // Create child DO
    const { stub: childStub } = await initNamedSession(childName, {
      repoOwner: "acme",
      repoName: "web-app",
      userId: "user-1",
      scmLogin: "acmedev",
    });

    // Seed D1 rows for both parent and child
    const store = new SessionIndexStore(env.DB);
    const now = Date.now();

    await store.create({
      id: pName,
      title: "Parent Session",
      repoOwner: "acme",
      repoName: "web-app",
      model: "anthropic/claude-sonnet-4-6",
      reasoningEffort: null,
      baseBranch: null,
      status: "active",
      spawnDepth: 0,
      createdAt: now,
      updatedAt: now,
    });

    await store.create({
      id: childName,
      title: "Child Session",
      repoOwner: "acme",
      repoName: "web-app",
      model: "anthropic/claude-sonnet-4-6",
      reasoningEffort: null,
      baseBranch: null,
      status: opts?.childStatus ?? "created",
      parentSessionId: pName,
      spawnSource: "agent",
      spawnDepth: 1,
      createdAt: now + 1,
      updatedAt: now + 1,
    });

    return { pName, childName, parentStub, childStub, sandboxToken, store };
  }

  async function setupNestedSession(
    store: SessionIndexStore,
    parentSessionId: string,
    spawnDepth: number,
    prefix: string,
    status: "active" | "completed" = "active"
  ): Promise<string> {
    const id = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await initNamedSession(id, { repoOwner: "acme", repoName: "web-app" });
    const now = Date.now();
    await store.create({
      id,
      title: "Nested Session",
      repoOwner: "acme",
      repoName: "web-app",
      model: "anthropic/claude-sonnet-4-6",
      reasoningEffort: null,
      baseBranch: null,
      status,
      parentSessionId,
      spawnSource: "agent",
      spawnDepth,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  describe("GET /sessions/:parentId/children", () => {
    it("returns children from D1", async () => {
      const { pName, childName, sandboxToken } = await setupParentAndChild();

      const res = await SELF.fetch(`https://test.local/sessions/${pName}/children`, {
        headers: { Authorization: `Bearer ${sandboxToken}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{
        children: Array<{ id: string; parentSessionId: string | null }>;
      }>();
      expect(body.children.length).toBeGreaterThanOrEqual(1);
      const child = body.children.find((c) => c.id === childName);
      expect(child).toBeDefined();
      expect(child!.parentSessionId).toBe(pName);
    });
  });

  describe("GET /sessions/:parentId/children/:childId", () => {
    it("returns child summary data", async () => {
      const { pName, childName, childStub, sandboxToken } = await setupParentAndChild();

      // Seed some events on the child DO for the summary
      await seedEvents(childStub, [
        {
          id: "evt-1",
          type: "tool_call",
          data: JSON.stringify({ tool: "read_file", args: { path: "/src/index.ts" } }),
          createdAt: Date.now(),
        },
      ]);

      const res = await SELF.fetch(`https://test.local/sessions/${pName}/children/${childName}`, {
        headers: { Authorization: `Bearer ${sandboxToken}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{
        session: { id: string; title: string; status: string; repoOwner: string };
        sandbox: { status: string } | null;
        artifacts: unknown[];
        recentEvents: Array<{ type: string }>;
      }>();

      expect(body.session).toBeDefined();
      expect(body.session.repoOwner).toBe("acme");
      expect(body.sandbox).not.toBeNull();
      expect(body.artifacts).toEqual(expect.any(Array));
      expect(body.recentEvents).toEqual(expect.any(Array));
      // The tool_call event should appear in recentEvents
      const toolCall = body.recentEvents.find((e) => e.type === "tool_call");
      expect(toolCall).toBeDefined();
    });

    it("forwards optional result and trajectory parameters to child summary", async () => {
      const { pName, childName, childStub, sandboxToken } = await setupParentAndChild();
      const [{ id: participantId }] = await queryDO<{ id: string }>(
        childStub,
        "SELECT id FROM participants LIMIT 1"
      );

      await queryDO(
        childStub,
        `INSERT INTO messages (id, author_id, content, source, status, created_at, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        "msg-child-result",
        participantId,
        "Do the child task",
        "web",
        "completed",
        100,
        110,
        200
      );
      await seedEvents(childStub, [
        {
          id: "evt-child-token",
          type: "token",
          data: JSON.stringify({ content: "usable child result" }),
          messageId: "msg-child-result",
          createdAt: 180,
        },
        {
          id: "evt-child-complete",
          type: "execution_complete",
          data: JSON.stringify({ success: true }),
          messageId: "msg-child-result",
          createdAt: 200,
        },
      ]);

      const res = await SELF.fetch(
        `https://test.local/sessions/${pName}/children/${childName}?include=result,trajectory`,
        { headers: { Authorization: `Bearer ${sandboxToken}` } }
      );

      expect(res.status).toBe(200);
      const body = await res.json<{
        finalResponse: { textContent: string; messageId: string } | null;
        trajectory: { events: Array<{ id: string }> };
      }>();

      expect(body.finalResponse).toMatchObject({
        messageId: "msg-child-result",
        textContent: "usable child result",
      });
      expect(body.trajectory.events.map((event) => event.id)).toEqual([
        "evt-child-token",
        "evt-child-complete",
      ]);
    });

    it("returns 404 for wrong parent", async () => {
      const { childName } = await setupParentAndChild();

      // Create a different "parent" session with sandbox auth
      const fakeName = `fake-parent-${Date.now()}`;
      const { stub: fakeStub } = await initNamedSession(fakeName, {
        repoOwner: "acme",
        repoName: "web-app",
      });
      const fakeToken = `sb-tok-fake-${Date.now()}`;
      await seedSandboxAuth(fakeStub, { authToken: fakeToken, sandboxId: "sb-fake-1" });

      // Seed D1 row for the fake parent
      const store = new SessionIndexStore(env.DB);
      const now = Date.now();
      await store.create({
        id: fakeName,
        title: "Fake Parent",
        repoOwner: "acme",
        repoName: "web-app",
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: null,
        baseBranch: null,
        status: "active",
        spawnDepth: 0,
        createdAt: now,
        updatedAt: now,
      });

      // Try to get the child through the wrong parent
      const res = await SELF.fetch(
        `https://test.local/sessions/${fakeName}/children/${childName}`,
        { headers: { Authorization: `Bearer ${fakeToken}` } }
      );

      expect(res.status).toBe(404);
    });
  });

  it("delivers a terminal child's final response to the parent agent", async () => {
    const { childName, parentStub, childStub } = await setupParentAndChild();
    const [{ id: participantId }] = await queryDO<{ id: string }>(
      childStub,
      "SELECT id FROM participants LIMIT 1"
    );

    await queryDO(
      childStub,
      `INSERT INTO messages (id, author_id, content, source, status, created_at, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      "msg-delivered-child-result",
      participantId,
      "Do the child task",
      "agent",
      "completed",
      100,
      110,
      200
    );
    await seedEvents(childStub, [
      {
        id: "evt-delivered-child-token",
        type: "token",
        data: JSON.stringify({ content: "The child completed the requested investigation." }),
        messageId: "msg-delivered-child-result",
        createdAt: 180,
      },
      {
        id: "evt-delivered-child-complete",
        type: "execution_complete",
        data: JSON.stringify({ success: true }),
        messageId: "msg-delivered-child-result",
        createdAt: 200,
      },
    ]);

    const response = await parentStub.fetch(
      new Request(buildSessionInternalUrl(SessionInternalPaths.childSessionUpdate), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          childSessionId: childName,
          status: "completed",
          title: "Child Session",
          deliverResult: true,
        }),
      })
    );
    expect(response.status).toBe(200);

    await vi.waitFor(async () => {
      const messages = await queryDO<{ content: string; source: string }>(
        parentStub,
        "SELECT content, source FROM messages WHERE source = 'agent'"
      );
      expect(messages).toContainEqual({
        content: expect.stringContaining("The child completed the requested investigation."),
        source: "agent",
      });
    });
  });

  describe("POST /sessions/:parentId/children/:childId/cancel", () => {
    it("cancels a running child session", async () => {
      const { pName, childName, sandboxToken, store } = await setupParentAndChild({
        childStatus: "active",
      });

      const res = await SELF.fetch(
        `https://test.local/sessions/${pName}/children/${childName}/cancel`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${sandboxToken}` },
        }
      );

      expect(res.status).toBe(200);
      const body = await res.json<{ status: string }>();
      expect(body.status).toBe("cancelled");

      // Verify D1 status was updated
      const child = await store.get(childName);
      expect(child).not.toBeNull();
      expect(child!.status).toBe("cancelled");

      // Verify the child DO's session status is also cancelled
      const childDoId = env.SESSION.idFromName(childName);
      const childStub = env.SESSION.get(childDoId);
      const rows = await queryDO<{ status: string }>(
        childStub,
        "SELECT status FROM session LIMIT 1"
      );
      expect(rows[0].status).toBe("cancelled");
    });

    it("cancels nested tasks by default", async () => {
      const { pName, childName, sandboxToken, store } = await setupParentAndChild({
        childStatus: "active",
      });
      const grandchildName = await setupNestedSession(store, childName, 2, "grandchild-ops");
      const greatGrandchildName = await setupNestedSession(
        store,
        grandchildName,
        3,
        "great-grandchild-ops"
      );
      const deeperDescendantNames: string[] = [];
      let deepestParentId = greatGrandchildName;
      for (let depth = 4; depth <= 12; depth += 1) {
        deepestParentId = await setupNestedSession(
          store,
          deepestParentId,
          depth,
          `descendant-depth-${depth}`
        );
        deeperDescendantNames.push(deepestParentId);
      }
      const siblingName = await setupNestedSession(store, pName, 1, "sibling-ops");
      const completedDescendantName = await setupNestedSession(
        store,
        childName,
        2,
        "completed-descendant-ops",
        "completed"
      );

      const res = await SELF.fetch(
        `https://test.local/sessions/${pName}/children/${childName}/cancel`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${sandboxToken}` },
        }
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        status: "cancelled",
        cancelledDescendantIds: [
          ...[...deeperDescendantNames].reverse(),
          greatGrandchildName,
          grandchildName,
          completedDescendantName,
        ],
      });
      expect((await store.get(childName))?.status).toBe("cancelled");
      expect((await store.get(grandchildName))?.status).toBe("cancelled");
      expect((await store.get(greatGrandchildName))?.status).toBe("cancelled");
      for (const descendantName of deeperDescendantNames) {
        expect((await store.get(descendantName))?.status).toBe("cancelled");
      }
      expect((await store.get(siblingName))?.status).toBe("active");
      expect((await store.get(completedDescendantName))?.status).toBe("cancelled");
    });

    it("cancels a live descendant whose indexed status is stale", async () => {
      const { pName, childName, sandboxToken, store } = await setupParentAndChild({
        childStatus: "active",
      });
      const grandchildName = await setupNestedSession(store, childName, 2, "stale-grandchild");
      await store.updateStatus(grandchildName, "completed");

      const res = await SELF.fetch(
        `https://test.local/sessions/${pName}/children/${childName}/cancel`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${sandboxToken}` },
        }
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        status: "cancelled",
        cancelledDescendantIds: [grandchildName],
      });
      expect((await store.get(grandchildName))?.status).toBe("cancelled");
    });

    it("blocks a late spawn when cancellation status projection fails", async () => {
      const { pName, childName, childStub, sandboxToken, store } = await setupParentAndChild({
        childStatus: "active",
      });
      const triggerName = `fail_cancel_projection_${Date.now()}`;
      await env.DB.prepare(
        `CREATE TRIGGER ${triggerName}
         BEFORE UPDATE OF status ON sessions
         WHEN OLD.id = '${childName}' AND NEW.status = 'cancelled'
         BEGIN
           SELECT RAISE(ABORT, 'forced status projection failure');
         END;`
      ).run();

      try {
        const res = await SELF.fetch(
          `https://test.local/sessions/${pName}/children/${childName}/cancel`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${sandboxToken}` },
          }
        );

        expect(res.status).toBe(200);
        expect((await store.get(childName))?.status).toBe("active");
        const [childSession] = await queryDO<{ status: string }>(
          childStub,
          "SELECT status FROM session LIMIT 1"
        );
        expect(childSession.status).toBe("cancelled");

        const now = Date.now();
        await expect(
          store.create({
            id: `late-child-${now}`,
            title: "Late child",
            repoOwner: "acme",
            repoName: "web-app",
            model: "anthropic/claude-sonnet-4-6",
            reasoningEffort: null,
            baseBranch: null,
            status: "created",
            parentSessionId: childName,
            spawnSource: "agent",
            spawnDepth: 2,
            createdAt: now,
            updatedAt: now,
          })
        ).rejects.toBeInstanceOf(ParentSessionSpawnRejectedError);
      } finally {
        await env.DB.prepare(`DROP TRIGGER IF EXISTS ${triggerName}`).run();
      }
    });

    it("rejects initialization when cancellation sees an indexed but empty child DO", async () => {
      const pName = parentName();
      const childName = `child-before-init-${Date.now()}`;
      const { stub: parentStub } = await initNamedSession(pName, {
        repoOwner: "acme",
        repoName: "web-app",
        userId: "user-1",
      });
      const sandboxToken = `sb-before-init-${Date.now()}`;
      await seedSandboxAuth(parentStub, { authToken: sandboxToken, sandboxId: "sb-before-init" });

      const store = new SessionIndexStore(env.DB);
      const now = Date.now();
      await store.create({
        id: pName,
        title: "Parent Session",
        repoOwner: "acme",
        repoName: "web-app",
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: null,
        baseBranch: null,
        status: "active",
        spawnDepth: 0,
        createdAt: now,
        updatedAt: now,
      });
      await store.create({
        id: childName,
        title: "Child before init",
        repoOwner: "acme",
        repoName: "web-app",
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: null,
        baseBranch: "main",
        status: "created",
        parentSessionId: pName,
        spawnSource: "agent",
        spawnDepth: 1,
        createdAt: now + 1,
        updatedAt: now + 1,
      });

      const cancelResponse = await SELF.fetch(
        `https://test.local/sessions/${pName}/children/${childName}/cancel`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${sandboxToken}` },
        }
      );
      expect(cancelResponse.status).toBe(502);

      const childStub = env.SESSION.get(env.SESSION.idFromName(childName));
      const initResponse = await childStub.fetch("http://internal/internal/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionName: childName,
          repoOwner: "acme",
          repoName: "web-app",
          repoId: 123,
          branch: "main",
          repositories: [
            {
              repoOwner: "acme",
              repoName: "web-app",
              repoId: 123,
              baseBranch: "main",
            },
          ],
          model: "anthropic/claude-sonnet-4-6",
          userId: "user-1",
          parentSessionId: pName,
          spawnSource: "agent",
          spawnDepth: 1,
        }),
      });

      expect(initResponse.status).toBe(409);
      await expect(initResponse.json()).resolves.toEqual({
        error: "Session initialization was cancelled",
      });
      const [{ count }] = await queryDO<{ count: number }>(
        childStub,
        "SELECT COUNT(*) AS count FROM session"
      );
      expect(count).toBe(0);
    });

    it("continues cascading when the direct child is already terminal", async () => {
      const { pName, childName, childStub, sandboxToken, store } = await setupParentAndChild({
        childStatus: "active",
      });
      const grandchildName = await setupNestedSession(store, childName, 2, "grandchild-retry");
      await store.updateStatus(childName, "cancelled");
      await queryDO(childStub, "UPDATE session SET status = 'cancelled'");

      const res = await SELF.fetch(
        `https://test.local/sessions/${pName}/children/${childName}/cancel`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${sandboxToken}` },
        }
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        status: "cancelled",
        cancelledDescendantIds: [grandchildName],
      });
      expect((await store.get(grandchildName))?.status).toBe("cancelled");
    });

    it("returns 409 for completed session", async () => {
      const { pName, childName, sandboxToken } = await setupParentAndChild({
        childStatus: "completed",
      });

      // Also update the child DO's session status to "completed" so the DO returns 409
      const childDoId = env.SESSION.idFromName(childName);
      const childStub = env.SESSION.get(childDoId);
      await queryDO(childStub, "UPDATE session SET status = 'completed'");

      const res = await SELF.fetch(
        `https://test.local/sessions/${pName}/children/${childName}/cancel`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${sandboxToken}` },
        }
      );

      expect(res.status).toBe(409);
      const body = await res.json<{ error: string }>();
      expect(body.error).toContain("completed");
    });

    it("returns 404 for wrong parent", async () => {
      const { childName } = await setupParentAndChild();

      // Create a different parent with sandbox auth
      const fakeName = `fake-cancel-${Date.now()}`;
      const { stub: fakeStub } = await initNamedSession(fakeName, {
        repoOwner: "acme",
        repoName: "web-app",
      });
      const fakeToken = `sb-tok-fake-cancel-${Date.now()}`;
      await seedSandboxAuth(fakeStub, { authToken: fakeToken, sandboxId: "sb-fake-cancel" });

      const store = new SessionIndexStore(env.DB);
      const now = Date.now();
      await store.create({
        id: fakeName,
        title: "Fake Parent",
        repoOwner: "acme",
        repoName: "web-app",
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: null,
        baseBranch: null,
        status: "active",
        spawnDepth: 0,
        createdAt: now,
        updatedAt: now,
      });

      const res = await SELF.fetch(
        `https://test.local/sessions/${fakeName}/children/${childName}/cancel`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${fakeToken}` },
        }
      );

      expect(res.status).toBe(404);
    });
  });

  describe("POST /internal/child-session-update", () => {
    it("broadcasts child_session_update to authenticated clients", async () => {
      const pName = parentName();
      await initNamedSession(pName, { repoOwner: "acme", repoName: "web-app" });

      // Seed D1 row so WS token generation works
      const store = new SessionIndexStore(env.DB);
      const now = Date.now();
      await store.create({
        id: pName,
        title: "Parent",
        repoOwner: "acme",
        repoName: "web-app",
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: null,
        baseBranch: null,
        status: "active",
        spawnDepth: 0,
        createdAt: now,
        updatedAt: now,
      });

      // Subscribe a WebSocket client on the parent
      const { ws } = await openClientWs(pName, { subscribe: true });

      // Collect messages, waiting for child_session_update
      const collector = collectMessages(ws, {
        until: (msg) => msg.type === "child_session_update",
        timeoutMs: 2000,
      });

      // Call the internal endpoint directly on the parent DO
      const parentStub = env.SESSION.get(env.SESSION.idFromName(pName));
      const res = await parentStub.fetch("http://internal/internal/child-session-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          childSessionId: "child-abc-123",
          status: "created",
          title: "Fix the tests",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ ok: boolean }>();
      expect(body.ok).toBe(true);

      // Verify the WebSocket client received the broadcast
      const messages = await collector;
      const update = messages.find((m) => m.type === "child_session_update");
      expect(update).toBeDefined();
      expect(update!.childSessionId).toBe("child-abc-123");
      expect(update!.status).toBe("created");
      expect(update!.title).toBe("Fix the tests");

      ws.close();
    });

    it("returns 400 when childSessionId is missing", async () => {
      const pName = parentName();
      const { stub } = await initNamedSession(pName);

      const res = await stub.fetch("http://internal/internal/child-session-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "created", title: "No ID" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(body.error).toContain("childSessionId");
    });

    it("returns 400 when status is missing", async () => {
      const pName = parentName();
      const { stub } = await initNamedSession(pName);

      const res = await stub.fetch("http://internal/internal/child-session-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ childSessionId: "child-1", title: "No status" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(body.error).toContain("status");
    });
  });
});
