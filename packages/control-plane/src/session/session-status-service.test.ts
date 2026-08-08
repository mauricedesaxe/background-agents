import { describe, expect, it, vi } from "vitest";
import { SessionStatusService } from "./session-status-service";
import { buildSessionInternalUrl, SessionInternalPaths } from "./contracts";
import type { Logger } from "../logger";
import type { SessionIndexStore } from "../db/session-index";
import type { SessionRow, ArtifactRow } from "./types";
import type { SessionRepository } from "./repository";
import type { SessionMessenger } from "./messenger";
import { SandboxProviderError } from "../sandbox/provider";

function createSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "session-1",
    session_name: "public-session-1",
    title: "Session title",
    repo_owner: "acme",
    repo_name: "repo",
    repo_id: 1,
    base_branch: "main",
    branch_name: "feature/test",
    base_sha: "base-sha",
    current_sha: "head-sha",
    opencode_session_id: "oc-1",
    model: "anthropic/claude-haiku-4-5",
    reasoning_effort: "high",
    status: "active",
    parent_session_id: null,
    spawn_source: "user",
    spawn_depth: 0,
    code_server_enabled: 0,
    total_cost: 2.5,
    sandbox_settings: null,
    environment_id: null,
    terminal_at: null,
    archive_requested_at: null,
    archive_claimed_at: null,
    created_at: 1000,
    updated_at: 2000,
    ...overrides,
  } as SessionRow;
}

function harness(options: { session?: SessionRow | null; sessionIndex?: null } = {}) {
  const session = options.session === undefined ? createSession() : options.session;

  const repository = {
    getSession: vi.fn(() => session),
    updateSessionStatus: vi.fn(
      (sessionId: string, status: SessionRow["status"], updatedAt: number) => {
        if (!session || session.id !== sessionId) return;
        session.status = status;
        session.updated_at = updatedAt;
        session.terminal_at = ["completed", "failed", "cancelled"].includes(status)
          ? (session.terminal_at ?? updatedAt)
          : null;
        if (status === "active" || status === "archived") {
          session.archive_requested_at = null;
          session.archive_claimed_at = null;
        }
      }
    ),
    claimSessionArchive: vi.fn((sessionId: string, claimedAt: number) => {
      if (!session || session.id !== sessionId || session.archive_claimed_at != null) return false;
      session.archive_claimed_at = claimedAt;
      session.archive_requested_at = session.archive_requested_at ?? claimedAt;
      return true;
    }),
    clearSessionArchiveClaim: vi.fn((sessionId: string, keepRetryRequest: boolean) => {
      if (!session || session.id !== sessionId) return;
      session.archive_claimed_at = null;
      if (!keepRetryRequest) session.archive_requested_at = null;
    }),
    extendTerminalActivity: vi.fn((sessionId: string, now: number) => {
      if (!session || session.id !== sessionId) return false;
      if (session.terminal_at == null || now <= session.terminal_at) return false;
      session.terminal_at = now;
      return true;
    }),
    getPendingOrProcessingCount: vi.fn(() => 0),
    getMessageCount: vi.fn(() => 3),
    getActiveDurationMs: vi.fn(() => 4500),
    listArtifacts: vi.fn(
      () => [{ type: "pr" }, { type: "screenshot" }, { type: "pr" }] as ArtifactRow[]
    ),
  };

  const broadcast = vi.fn();
  const messenger = { broadcast, sendToSandbox: vi.fn(() => true) } as SessionMessenger;

  const sessionIndex =
    options.sessionIndex === null
      ? null
      : {
          updateStatus: vi.fn(async () => true),
          updateMetrics: vi.fn(async () => true),
          archiveDescendants: vi.fn(async () => 0),
          restoreArchivedSession: vi.fn(async () => true),
          listByParent: vi.fn(async () => []),
          hasUnfinishedDescendants: vi.fn(async () => false),
        };

  const waitUntil = vi.fn();
  const getAlarm = vi.fn(async () => null as number | null);
  const setAlarm = vi.fn(async (_deadlineAt: number) => {});
  const durableStorage = new Map<string, unknown>();
  const get = vi.fn(async (key: string) => durableStorage.get(key));
  const put = vi.fn(async (key: string, value: unknown) => {
    durableStorage.set(key, value);
  });
  const deleteValue = vi.fn(async (key: string) => {
    durableStorage.delete(key);
  });
  const ctx = {
    waitUntil,
    id: { toString: () => "do-id" },
    storage: { getAlarm, setAlarm, get, put, delete: deleteValue },
  } as unknown as DurableObjectState;

  const parentFetch = vi.fn(async (_request: Request) => new Response(null, { status: 200 }));
  const parentStub = { fetch: parentFetch };
  const parentSessions = {
    idFromName: vi.fn(() => "parent-do-id"),
    get: vi.fn(() => parentStub),
  };
  const archiveSandbox = vi.fn(async (_reason: string) => {});

  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };

  const service = new SessionStatusService(
    ctx,
    log as unknown as Logger,
    repository as unknown as SessionRepository,
    messenger,
    sessionIndex as unknown as SessionIndexStore | null,
    parentSessions as unknown as DurableObjectNamespace,
    archiveSandbox
  );

  return {
    service,
    repository,
    broadcast,
    sessionIndex,
    waitUntil,
    getAlarm,
    setAlarm,
    durableStorage,
    parentSessions,
    parentFetch,
    archiveSandbox,
    log,
  };
}

describe("SessionStatusService.transition", () => {
  it("returns false without side effects when there is no session", async () => {
    const h = harness({ session: null });

    expect(await h.service.transition("active")).toBe(false);

    expect(h.repository.updateSessionStatus).not.toHaveBeenCalled();
    expect(h.sessionIndex!.updateStatus).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it("persists, mirrors to the index, and broadcasts on a real transition", async () => {
    const h = harness({ session: createSession({ status: "created" }) });

    expect(await h.service.transition("active")).toBe(true);

    expect(h.repository.updateSessionStatus).toHaveBeenCalledWith(
      "session-1",
      "active",
      expect.any(Number)
    );
    const updatedAt = h.repository.updateSessionStatus.mock.calls[0][2] as number;
    expect(updatedAt).toBeGreaterThan(2000);
    expect(h.sessionIndex!.updateStatus).toHaveBeenCalledWith(
      "public-session-1",
      "active",
      updatedAt
    );
    expect(h.broadcast).toHaveBeenCalledWith({ type: "session_status", status: "active" });
  });

  it("short-circuits on same status: refreshes the index but neither persists nor broadcasts", async () => {
    const h = harness({ session: createSession({ status: "active" }) });

    expect(await h.service.transition("active")).toBe(false);

    expect(h.sessionIndex!.updateStatus).toHaveBeenCalledWith("public-session-1", "active", 2000);
    expect(h.repository.updateSessionStatus).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.parentFetch).not.toHaveBeenCalled();
  });

  it("syncs metrics on a terminal transition", async () => {
    const h = harness({ session: createSession({ status: "active" }) });

    await h.service.transition("completed");

    expect(h.sessionIndex!.updateMetrics).toHaveBeenCalledWith("public-session-1", {
      totalCost: 2.5,
      activeDurationMs: 4500,
      messageCount: 3,
      prCount: 2,
    });
    expect(h.waitUntil).toHaveBeenCalled();
  });

  it.each(["user", "agent", "github-bot", "linear-bot", "slack-bot"] as const)(
    "schedules %s sessions to archive 12 hours after completion",
    async (spawnSource) => {
      const h = harness({
        session: createSession({ status: "active", spawn_source: spawnSource }),
      });

      await h.service.transition("completed");

      const terminalAt = h.repository.updateSessionStatus.mock.calls[0][2] as number;
      expect(h.setAlarm).toHaveBeenCalledWith(terminalAt + 12 * 60 * 60 * 1000);
    }
  );

  it("schedules automation sessions to archive one hour after completion", async () => {
    const h = harness({
      session: createSession({ status: "active", spawn_source: "automation" }),
    });

    await h.service.transition("completed");

    const terminalAt = h.repository.updateSessionStatus.mock.calls[0][2] as number;
    expect(h.setAlarm).toHaveBeenCalledWith(terminalAt + 60 * 60 * 1000);
  });

  it("syncs metrics even when already in the terminal status", async () => {
    const h = harness({ session: createSession({ status: "failed" }) });

    expect(await h.service.transition("failed")).toBe(false);

    expect(h.sessionIndex!.updateMetrics).toHaveBeenCalledWith(
      "public-session-1",
      expect.any(Object)
    );
  });

  it("reopens child spawning when an archived session is restored", async () => {
    const h = harness({ session: createSession({ status: "archived" }) });

    expect(await h.service.unarchive()).toBe(true);

    expect(h.sessionIndex!.restoreArchivedSession).toHaveBeenCalledWith(
      "public-session-1",
      expect.any(Number)
    );
    expect(h.sessionIndex!.updateStatus).not.toHaveBeenCalled();
  });

  it("archives descendant index rows before broadcasting the parent archive", async () => {
    const h = harness({ session: createSession({ status: "active" }) });

    await h.service.transition("archived");

    const updatedAt = h.repository.updateSessionStatus.mock.calls[0][2] as number;
    expect(h.sessionIndex!.archiveDescendants).toHaveBeenCalledWith("public-session-1", updatedAt);
    expect(h.sessionIndex!.archiveDescendants.mock.invocationCallOrder[0]).toBeLessThan(
      h.broadcast.mock.invocationCallOrder[0]
    );
  });

  it("retries descendant reconciliation when the session is already archived", async () => {
    const h = harness({ session: createSession({ status: "archived" }) });
    h.sessionIndex!.archiveDescendants.mockRejectedValueOnce(
      new Error("d1 down")
    ).mockResolvedValueOnce(1);

    expect(await h.service.transition("archived")).toBe(false);
    expect(await h.service.transition("archived")).toBe(false);

    expect(h.sessionIndex!.archiveDescendants).toHaveBeenCalledTimes(2);
    expect(h.sessionIndex!.archiveDescendants).toHaveBeenLastCalledWith("public-session-1", 2000);
    expect(h.sessionIndex!.listByParent).toHaveBeenCalledTimes(2);
    expect(h.log.error).toHaveBeenCalledWith(
      "cascade_archive.index_failed",
      expect.objectContaining({ parent_id: "public-session-1" })
    );
  });

  it("does not sync metrics on a non-terminal transition", async () => {
    const h = harness({ session: createSession({ status: "created" }) });

    await h.service.transition("active");

    expect(h.sessionIndex!.updateMetrics).not.toHaveBeenCalled();
  });

  it("logs index sync failures without throwing", async () => {
    const h = harness({ session: createSession({ status: "created" }) });
    h.sessionIndex!.updateStatus.mockRejectedValue(new Error("d1 down"));

    expect(await h.service.transition("active")).toBe(true);

    expect(h.log.error).toHaveBeenCalledWith(
      "session_index.update_status.background_error",
      expect.objectContaining({
        session_id: "public-session-1",
        status: "active",
        error: expect.any(Error),
      })
    );
    expect(h.broadcast).toHaveBeenCalledWith({ type: "session_status", status: "active" });
  });

  it("broadcasts the new status only after the index write resolves", async () => {
    const h = harness({ session: createSession({ status: "created" }) });

    let releaseIndexWrite!: () => void;
    h.sessionIndex!.updateStatus.mockReturnValue(
      new Promise<boolean>((resolve) => {
        releaseIndexWrite = () => resolve(true);
      })
    );

    const transition = h.service.transition("active");
    await Promise.resolve();

    expect(h.sessionIndex!.updateStatus).toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();

    releaseIndexWrite();
    await transition;

    expect(h.broadcast).toHaveBeenCalledWith({ type: "session_status", status: "active" });
  });

  it("skips index and metrics writes when no session index is bound", async () => {
    const h = harness({ session: createSession({ status: "active" }), sessionIndex: null });

    expect(await h.service.transition("completed")).toBe(true);

    expect(h.broadcast).toHaveBeenCalledWith({ type: "session_status", status: "completed" });
    expect(h.waitUntil).not.toHaveBeenCalled();
  });

  it("notifies the parent session fire-and-forget via ctx.waitUntil", async () => {
    const h = harness({
      session: createSession({ status: "active", parent_session_id: "parent-1" }),
    });

    await h.service.transition("completed");

    expect(h.parentSessions.idFromName).toHaveBeenCalledWith("parent-1");
    expect(h.parentFetch).toHaveBeenCalledTimes(1);
    const request = h.parentFetch.mock.calls[0][0];
    expect(request.url).toBe(buildSessionInternalUrl(SessionInternalPaths.childSessionUpdate));
    expect(request.method).toBe("POST");
    expect(await request.json()).toEqual({
      childSessionId: "public-session-1",
      status: "completed",
      title: "Session title",
      deliverResult: true,
      childResultMessageId: null,
    });
    expect(h.waitUntil).toHaveBeenCalled();
  });

  it("retries non-successful parent result delivery responses", async () => {
    const h = harness({
      session: createSession({ status: "active", parent_session_id: "parent-1" }),
    });
    h.parentFetch
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await h.service.transition("completed", "child-message-1");

    expect(h.parentFetch).toHaveBeenCalledTimes(3);
    const request = h.parentFetch.mock.calls[2][0];
    expect(await request.json()).toMatchObject({ childResultMessageId: "child-message-1" });
  });

  it("retains failed parent result delivery for an alarm retry", async () => {
    const h = harness({
      session: createSession({ status: "active", parent_session_id: "parent-1" }),
    });
    h.parentFetch.mockRejectedValue(new Error("parent unavailable"));

    await h.service.transition("completed", "child-message-1");

    expect(h.parentFetch).toHaveBeenCalledTimes(3);
    expect(h.durableStorage.get("pendingParentNotifications")).toHaveLength(1);
    expect(h.setAlarm).toHaveBeenCalled();
    expect(h.sessionIndex!.updateStatus).not.toHaveBeenCalled();

    h.parentFetch.mockResolvedValue(new Response(null, { status: 200 }));
    await h.service.retryPendingParentNotifications();

    expect(h.durableStorage.has("pendingParentNotifications")).toBe(false);
    expect(h.sessionIndex!.updateStatus).toHaveBeenCalledWith(
      "public-session-1",
      "completed",
      expect.any(Number)
    );
  });

  it("does not notify a parent when the session has none", async () => {
    const h = harness({ session: createSession({ status: "created" }) });

    await h.service.transition("active");

    expect(h.parentFetch).not.toHaveBeenCalled();
  });
});

describe("SessionStatusService.reconcileAfterExecution", () => {
  it("returns to active when more prompts are pending", async () => {
    const h = harness({ session: createSession({ status: "created" }) });
    h.repository.getPendingOrProcessingCount.mockReturnValue(2);

    await h.service.reconcileAfterExecution(true);

    expect(h.broadcast).toHaveBeenCalledWith({ type: "session_status", status: "active" });
  });

  it("completes when idle and the execution succeeded", async () => {
    const h = harness({ session: createSession({ status: "active" }) });

    await h.service.reconcileAfterExecution(true);

    expect(h.broadcast).toHaveBeenCalledWith({ type: "session_status", status: "completed" });
  });

  it("fails when idle and the execution failed", async () => {
    const h = harness({ session: createSession({ status: "active" }) });

    await h.service.reconcileAfterExecution(false);

    expect(h.broadcast).toHaveBeenCalledWith({ type: "session_status", status: "failed" });
  });
});

describe("SessionStatusService.handleAutoArchiveAlarm", () => {
  it("archives an automation session and its sandbox one hour after completion", async () => {
    const terminalAt = 10_000;
    const h = harness({
      session: createSession({
        status: "completed",
        spawn_source: "automation",
        updated_at: terminalAt,
      }),
    });
    await h.service.handleAutoArchiveAlarm(terminalAt + 60 * 60 * 1000);

    expect(h.repository.updateSessionStatus).toHaveBeenCalledWith(
      "session-1",
      "archived",
      expect.any(Number)
    );
    expect(h.archiveSandbox).toHaveBeenCalledWith("session_auto_archived");
  });

  it("keeps a completed session available until its retention deadline", async () => {
    const terminalAt = 10_000;
    const h = harness({
      session: createSession({ status: "completed", updated_at: terminalAt }),
    });
    await h.service.handleAutoArchiveAlarm(terminalAt + 1000);

    expect(h.repository.updateSessionStatus).not.toHaveBeenCalled();
    expect(h.archiveSandbox).not.toHaveBeenCalled();
    expect(h.setAlarm).toHaveBeenCalledWith(terminalAt + 12 * 60 * 60 * 1000);
  });

  it("keeps the original retention deadline after later metadata updates", async () => {
    const terminalAt = 10_000;
    const h = harness({
      session: createSession({
        status: "completed",
        terminal_at: terminalAt,
        updated_at: terminalAt + 6 * 60 * 60 * 1000,
      }),
    });

    await h.service.handleAutoArchiveAlarm(terminalAt + 12 * 60 * 60 * 1000);

    expect(h.archiveSandbox).toHaveBeenCalledWith("session_auto_archived");
  });

  it("durably retries timed archival after the provider recovers", async () => {
    const terminalAt = 10_000;
    const session = createSession({
      status: "completed",
      terminal_at: terminalAt,
      updated_at: terminalAt,
    });
    const h = harness({ session });
    h.archiveSandbox.mockRejectedValueOnce(new Error("provider unavailable"));

    await h.service.handleAutoArchiveAlarm(terminalAt + 12 * 60 * 60 * 1000);

    expect(session.archive_claimed_at).toBeNull();
    expect(session.archive_requested_at).not.toBeNull();
    expect(h.setAlarm).toHaveBeenCalled();

    await h.service.handleAutoArchiveAlarm(terminalAt + 13 * 60 * 60 * 1000);

    expect(h.archiveSandbox).toHaveBeenCalledTimes(2);
    expect(session.status).toBe("archived");
    expect(session.archive_requested_at).toBeNull();
  });

  it("does not retry permanent provider archive failures", async () => {
    const terminalAt = 10_000;
    const session = createSession({
      status: "completed",
      terminal_at: terminalAt,
      updated_at: terminalAt,
    });
    const h = harness({ session });
    h.archiveSandbox.mockRejectedValueOnce(
      new SandboxProviderError("quota exhausted", "permanent")
    );

    await h.service.handleAutoArchiveAlarm(terminalAt + 12 * 60 * 60 * 1000);

    expect(session.archive_claimed_at).toBeNull();
    expect(session.archive_requested_at).toBeNull();
    expect(h.setAlarm).toHaveBeenCalledTimes(1);
  });

  it("discards a failed archive request after the session resumes", async () => {
    const session = createSession({
      status: "active",
      archive_requested_at: 10_000,
      archive_claimed_at: null,
    });
    const h = harness({ session });

    await h.service.handleAutoArchiveAlarm(Number.MAX_SAFE_INTEGER);

    expect(h.repository.clearSessionArchiveClaim).toHaveBeenCalledWith("session-1", false);
    expect(h.archiveSandbox).not.toHaveBeenCalled();
    expect(session.status).toBe("active");
  });

  it("blocks resume while provider archival is in flight", async () => {
    const session = createSession({ status: "completed" });
    const h = harness({ session });
    let releaseArchive!: () => void;
    h.archiveSandbox.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseArchive = resolve;
      })
    );

    const archive = h.service.archive("session_archived");
    await Promise.resolve();

    expect(session.archive_claimed_at).not.toBeNull();
    expect(await h.service.unarchive()).toBe(false);
    expect(session.status).toBe("completed");

    releaseArchive();
    await expect(archive).resolves.toBe("archived");
  });

  it("re-arms the archive alarm at the extended deadline after post-terminal activity", async () => {
    const terminalAt = 10_000;
    const session = createSession({ status: "completed", terminal_at: terminalAt });
    const h = harness({ session });

    const activityAt = terminalAt + 6 * 60 * 60 * 1000;
    h.service.recordTerminalActivity(activityAt);
    expect(session.terminal_at).toBe(activityAt);

    await h.service.handleAutoArchiveAlarm(terminalAt + 12 * 60 * 60 * 1000);

    expect(h.archiveSandbox).not.toHaveBeenCalled();
    expect(h.setAlarm).toHaveBeenCalledWith(activityAt + 12 * 60 * 60 * 1000);
  });

  it("re-reads terminal activity after checking descendants", async () => {
    const terminalAt = 10_000;
    const activityAt = terminalAt + 6 * 60 * 60 * 1000;
    const staleSession = createSession({ status: "completed", terminal_at: terminalAt });
    const latestSession = createSession({ status: "completed", terminal_at: activityAt });
    const h = harness({ session: staleSession });
    h.repository.getSession.mockReturnValueOnce(staleSession).mockReturnValueOnce(latestSession);

    await h.service.handleAutoArchiveAlarm(terminalAt + 12 * 60 * 60 * 1000);

    expect(h.archiveSandbox).not.toHaveBeenCalled();
    expect(h.setAlarm).toHaveBeenCalledWith(activityAt + 12 * 60 * 60 * 1000);
  });

  it("defers parent auto-archive while a child is unfinished", async () => {
    const terminalAt = 10_000;
    const h = harness({
      session: createSession({ status: "completed", terminal_at: terminalAt }),
    });
    h.sessionIndex!.hasUnfinishedDescendants.mockResolvedValue(true);

    await h.service.handleAutoArchiveAlarm(terminalAt + 12 * 60 * 60 * 1000);

    expect(h.archiveSandbox).not.toHaveBeenCalled();
    expect(h.setAlarm).toHaveBeenCalledWith(terminalAt + 12 * 60 * 60 * 1000 + 5 * 60 * 1000);
  });

  it("never auto-archives an active session", async () => {
    const h = harness({ session: createSession({ status: "active" }) });
    await h.service.handleAutoArchiveAlarm(Number.MAX_SAFE_INTEGER);

    expect(h.repository.updateSessionStatus).not.toHaveBeenCalled();
    expect(h.archiveSandbox).not.toHaveBeenCalled();
  });
});

describe("SessionStatusService.recordTerminalActivity", () => {
  it("extends terminal_at forward when a terminal session stays active", () => {
    const terminalAt = 10_000;
    const session = createSession({ status: "completed", terminal_at: terminalAt });
    const h = harness({ session });

    h.service.recordTerminalActivity(terminalAt + 3 * 60 * 1000);

    expect(h.repository.extendTerminalActivity).toHaveBeenCalledWith(
      "session-1",
      terminalAt + 3 * 60 * 1000
    );
    expect(session.terminal_at).toBe(terminalAt + 3 * 60 * 1000);
  });

  it("is a no-op when the session is not terminal", () => {
    const h = harness({ session: createSession({ status: "active", terminal_at: null }) });

    h.service.recordTerminalActivity(99_999);

    expect(h.repository.extendTerminalActivity).toHaveBeenCalledWith("session-1", 99_999);
    expect(h.sessionIndex).toBeDefined();
  });

  it("does not contract terminal_at when an earlier event arrives", () => {
    const terminalAt = 50_000;
    const session = createSession({ status: "completed", terminal_at: terminalAt });
    const h = harness({ session });

    h.service.recordTerminalActivity(40_000);

    expect(session.terminal_at).toBe(terminalAt);
  });

  it("is a no-op when there is no session", () => {
    const h = harness({ session: null });

    h.service.recordTerminalActivity(1);

    expect(h.repository.extendTerminalActivity).not.toHaveBeenCalled();
  });
});

describe("SessionStatusService.notifyParentOfChildUpdate", () => {
  it("posts the child update to the parent Durable Object", async () => {
    const h = harness();

    h.service.notifyParentOfChildUpdate(
      { parent_session_id: "parent-1", title: "Old title" },
      "public-session-1",
      { status: "active", title: "New title" }
    );

    expect(h.parentSessions.idFromName).toHaveBeenCalledWith("parent-1");
    const request = h.parentFetch.mock.calls[0][0];
    expect(await request.json()).toEqual({
      childSessionId: "public-session-1",
      status: "active",
      title: "New title",
      deliverResult: false,
    });
    expect(h.waitUntil).toHaveBeenCalledTimes(1);
  });

  it("logs (and does not throw) when the parent notification fails", async () => {
    const h = harness();
    h.parentFetch.mockRejectedValue(new Error("parent unreachable"));

    h.service.notifyParentOfChildUpdate(
      { parent_session_id: "parent-1", title: null },
      "public-session-1",
      { status: "failed", title: null }
    );

    // Drain the fire-and-forget promise handed to waitUntil.
    await h.waitUntil.mock.calls[0][0];

    expect(h.log.error).toHaveBeenCalledWith(
      "notify_parent.failed",
      expect.objectContaining({
        parent_id: "parent-1",
        child_id: "public-session-1",
        status: "failed",
        error: expect.any(Error),
      })
    );
  });

  it("is a no-op without a parent session id", () => {
    const h = harness();

    h.service.notifyParentOfChildUpdate({ parent_session_id: null, title: null }, "child-1", {
      status: "active",
      title: null,
    });

    expect(h.parentSessions.idFromName).not.toHaveBeenCalled();
    expect(h.waitUntil).not.toHaveBeenCalled();
  });
});

describe("SessionStatusService archive cascade", () => {
  it("retries a child archive when the child Durable Object temporarily rejects it", async () => {
    const h = harness({ session: createSession({ status: "completed" }) });
    h.sessionIndex!.listByParent.mockResolvedValue([
      { id: "child-1", status: "completed" },
    ] as never);
    h.parentFetch
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await h.service.transition("archived");
    await h.waitUntil.mock.calls[0][0];

    expect(h.parentFetch).toHaveBeenCalledTimes(2);
    expect(h.log.error).not.toHaveBeenCalledWith("cascade_archive.child_failed", expect.anything());
  });

  it("re-arms the parent alarm when immediate child retries are exhausted", async () => {
    const h = harness({ session: createSession({ status: "completed" }) });
    h.sessionIndex!.listByParent.mockResolvedValue([
      { id: "child-1", status: "completed" },
    ] as never);
    h.parentFetch.mockRejectedValueOnce(new Error("unavailable"));
    h.parentFetch.mockRejectedValueOnce(new Error("unavailable"));
    h.parentFetch.mockRejectedValueOnce(new Error("unavailable"));

    await h.service.transition("archived");
    await h.waitUntil.mock.calls[0][0];

    expect(h.parentFetch).toHaveBeenCalledTimes(3);
    expect(h.setAlarm).toHaveBeenCalled();

    await h.service.handleAutoArchiveAlarm(Number.MAX_SAFE_INTEGER);
    await h.waitUntil.mock.calls[1][0];

    expect(h.parentFetch).toHaveBeenCalledTimes(4);
  });
});
