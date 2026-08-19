import { describe, expect, it } from "vitest";
import {
  applyTitleUpdate,
  applySessionReadState,
  buildGroupedSessionList,
  buildSessionSearchValue,
  buildSessionsPageKey,
  CURRENT_USER_CREATED_BY,
  isArchivedSessionListKey,
  isSessionListKey,
  isUnarchivedSessionListKey,
  sessionSource,
  type SessionListResponse,
} from "./session-list";
import type { SessionListItem } from "@open-inspect/shared/types/session-inbox";
import type { Session } from "@open-inspect/shared/types/sessions";

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    title: id.toUpperCase(),
    repoOwner: "open-inspect",
    repoName: "background-agents",
    baseBranch: "main",
    branchName: null,
    baseSha: null,
    currentSha: null,
    opencodeSessionId: null,
    status: "active",
    parentSessionId: null,
    spawnSource: "user",
    spawnDepth: 0,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

describe("buildSessionsPageKey", () => {
  it("adds the current-user creator filter", () => {
    expect(
      buildSessionsPageKey({
        excludeStatus: "archived",
        excludeAutomationLineage: true,
        createdBy: [CURRENT_USER_CREATED_BY],
      })
    ).toBe(
      "/api/sessions?limit=50&offset=0&excludeStatus=archived&excludeAutomationLineage=true&createdBy=me"
    );
  });

  it("adds repeated creator filters", () => {
    expect(
      buildSessionsPageKey({
        excludeStatus: "archived",
        createdBy: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
      })
    ).toBe(
      "/api/sessions?limit=50&offset=0&excludeStatus=archived&createdBy=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&createdBy=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    );
  });
});

describe("applySessionReadState", () => {
  it("does not let an older mutation response overwrite a newer terminal message", () => {
    const data: SessionListResponse = {
      sessions: [
        session("session-1", {
          readState: {
            unread: true,
            latestMessageId: "message-b",
          },
        }),
      ],
      hasMore: false,
    };

    expect(
      applySessionReadState(data, "session-1", {
        unread: false,
        latestMessageId: "message-a",
      })?.sessions[0].readState
    ).toEqual({
      unread: true,
      latestMessageId: "message-b",
    });
    expect(
      applySessionReadState(data, "session-1", {
        unread: false,
        latestMessageId: "message-b",
      })?.sessions[0].readState
    ).toEqual({
      unread: false,
      latestMessageId: "message-b",
    });
  });
});

describe("buildSessionSearchValue", () => {
  it("includes every repository attached to a multi-repository session", () => {
    const value = buildSessionSearchValue(
      session("multi", {
        title: "Update services",
        repositories: [
          {
            repoOwner: "open-inspect",
            repoName: "background-agents",
            repoId: 1,
            baseBranch: "main",
          },
          { repoOwner: "acme", repoName: "api", repoId: 2, baseBranch: "main" },
        ],
      })
    );

    expect(value).toContain("Update services");
    expect(value).toContain("open-inspect/background-agents");
    expect(value).toContain("acme/api");
  });

  it("falls back to the scalar repository fields", () => {
    expect(buildSessionSearchValue(session("legacy"))).toContain("open-inspect/background-agents");
  });
});

describe("isSessionListKey", () => {
  it("matches all session list cache keys", () => {
    expect(isSessionListKey("/api/sessions")).toBe(true);
    expect(isSessionListKey("/api/sessions?limit=50&offset=0")).toBe(true);
  });

  it("ignores other cache keys", () => {
    expect(isSessionListKey("/api/sessions/session-1")).toBe(false);
    expect(isSessionListKey(["/api/sessions"])).toBe(false);
  });
});

describe("isUnarchivedSessionListKey", () => {
  it("matches active session list variants", () => {
    expect(isUnarchivedSessionListKey("/api/sessions")).toBe(true);
    expect(isUnarchivedSessionListKey("/api/sessions?excludeStatus=archived")).toBe(true);
    expect(isUnarchivedSessionListKey("/api/sessions?status=active")).toBe(true);
  });

  it("ignores archived session lists", () => {
    expect(isUnarchivedSessionListKey("/api/sessions?status=archived&limit=20")).toBe(false);
  });
});

describe("isArchivedSessionListKey", () => {
  it("matches archived session lists", () => {
    expect(isArchivedSessionListKey("/api/sessions?status=archived")).toBe(true);
    expect(isArchivedSessionListKey("/api/sessions?status=archived&limit=20")).toBe(true);
  });

  it("ignores unarchived session lists", () => {
    expect(isArchivedSessionListKey("/api/sessions")).toBe(false);
    expect(isArchivedSessionListKey("/api/sessions?excludeStatus=archived")).toBe(false);
    expect(isArchivedSessionListKey("/api/sessions?status=active")).toBe(false);
  });
});

describe("applyTitleUpdate", () => {
  it("replaces only the title of the matching session", () => {
    const before: SessionListResponse = {
      sessions: [session("a"), session("b"), session("c")],
      hasMore: false,
    };

    const after = applyTitleUpdate(before, "b", "Renamed");

    expect(after?.sessions).toEqual([
      session("a"),
      session("b", { title: "Renamed" }),
      session("c"),
    ]);
  });

  it("preserves hasMore and other top-level fields", () => {
    const before: SessionListResponse = {
      sessions: [session("a")],
      hasMore: true,
    };

    const after = applyTitleUpdate(before, "a", "New");

    expect(after?.hasMore).toBe(true);
  });

  it("returns undefined when data is undefined (cache miss)", () => {
    expect(applyTitleUpdate(undefined, "a", "New")).toBeUndefined();
  });

  it("leaves the list unchanged when sessionId does not match", () => {
    const before: SessionListResponse = {
      sessions: [session("a"), session("b")],
      hasMore: false,
    };

    const after = applyTitleUpdate(before, "missing", "New");

    expect(after?.sessions).toEqual(before.sessions);
  });

  it("does not mutate the input object", () => {
    const before: SessionListResponse = {
      sessions: [session("a")],
      hasMore: false,
    };
    const beforeSnapshot = structuredClone(before);

    applyTitleUpdate(before, "a", "Mutated");

    expect(before).toEqual(beforeSnapshot);
  });
});

function listItem(id: string, overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id,
    title: id.toUpperCase(),
    repoOwner: "open-inspect",
    repoName: "background-agents",
    baseBranch: "main",
    status: "active",
    parentSessionId: null,
    spawnSource: "user",
    environmentId: null,
    createdAt: 1000,
    updatedAt: 2000,
    readState: { latestMessageId: null, unread: false },
    ...overrides,
  };
}

describe("buildGroupedSessionList", () => {
  it("groups roots by repository", () => {
    const groups = buildGroupedSessionList([
      listItem("a", { repoOwner: "acme", repoName: "web", updatedAt: 30 }),
      listItem("b", { repoOwner: "acme", repoName: "api", updatedAt: 20 }),
      listItem("c", { repoOwner: "acme", repoName: "web", updatedAt: 10 }),
    ]);

    const web = groups.find((group) => group.label === "acme/web");
    const api = groups.find((group) => group.label === "acme/api");
    expect(groups).toHaveLength(2);
    expect(web?.buckets.flatMap((bucket) => bucket.sessions.map((s) => s.id))).toEqual(["a", "c"]);
    expect(api?.buckets.flatMap((bucket) => bucket.sessions.map((s) => s.id))).toEqual(["b"]);
  });

  it("buckets a no-repository session and a multi-repository session apart", () => {
    const groups = buildGroupedSessionList([
      listItem("scalar", { repoOwner: "acme", repoName: "web" }),
      listItem("none", { repoOwner: null, repoName: null }),
      listItem("multi", {
        repoOwner: "acme",
        repoName: "web",
        repositories: [
          { repoOwner: "acme", repoName: "web", repoId: 1, baseBranch: "main" },
          { repoOwner: "acme", repoName: "api", repoId: 2, baseBranch: "main" },
        ],
      }),
    ]);

    const labels = groups.map((group) => group.label).sort();
    expect(labels).toEqual(["Multiple repositories", "No repository", "acme/web"]);
  });

  it("separates automatic sessions from manual ones inside a repo group", () => {
    const groups = buildGroupedSessionList([
      listItem("manual", { spawnSource: "user" }),
      listItem("scheduled", { spawnSource: "automation" }),
      listItem("bot", { spawnSource: "github-bot" }),
    ]);

    expect(groups).toHaveLength(1);
    const [group] = groups;
    const manual = group.buckets.find((bucket) => bucket.source === "manual");
    const automatic = group.buckets.find((bucket) => bucket.source === "automatic");
    expect(manual?.sessions.map((s) => s.id).sort()).toEqual(["bot", "manual"]);
    expect(automatic?.sessions.map((s) => s.id)).toEqual(["scheduled"]);
    expect(group.buckets.map((bucket) => bucket.source)).toEqual(["manual", "automatic"]);
  });

  it("classifies only the automation spawn source as automatic", () => {
    expect(sessionSource({ spawnSource: "automation" })).toBe("automatic");
    expect(sessionSource({ spawnSource: "user" })).toBe("manual");
    expect(sessionSource({ spawnSource: "linear-bot" })).toBe("manual");
  });

  it("orders groups by their most recent session", () => {
    const groups = buildGroupedSessionList([
      listItem("old", { repoOwner: "acme", repoName: "api", updatedAt: 5 }),
      listItem("new", { repoOwner: "acme", repoName: "web", updatedAt: 99 }),
    ]);

    expect(groups.map((group) => group.label)).toEqual(["acme/web", "acme/api"]);
  });
});
