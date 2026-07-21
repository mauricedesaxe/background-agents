import { describe, expect, it } from "vitest";
import {
  applyTitleUpdate,
  buildGroupedSessionList,
  buildSessionsPageKey,
  collectSessionAndDescendantIds,
  CURRENT_USER_CREATED_BY,
  isArchivedSessionListKey,
  isSessionListKey,
  isUnarchivedSessionListKey,
  type SessionListResponse,
} from "./session-list";
import type { Session } from "@open-inspect/shared";

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
      buildSessionsPageKey({ excludeStatus: "archived", createdBy: [CURRENT_USER_CREATED_BY] })
    ).toBe("/api/sessions?limit=50&offset=0&excludeStatus=archived&createdBy=me");
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
  it("replaces the title and updatedAt of the matching session", () => {
    const before: SessionListResponse = {
      sessions: [session("a"), session("b"), session("c")],
      hasMore: false,
    };

    const after = applyTitleUpdate(before, "b", "Renamed", 9999);

    expect(after?.sessions).toEqual([
      session("a"),
      session("b", { title: "Renamed", updatedAt: 9999 }),
      session("c"),
    ]);
  });

  it("preserves hasMore and other top-level fields", () => {
    const before: SessionListResponse = {
      sessions: [session("a")],
      hasMore: true,
    };

    const after = applyTitleUpdate(before, "a", "New", 1);

    expect(after?.hasMore).toBe(true);
  });

  it("returns undefined when data is undefined (cache miss)", () => {
    expect(applyTitleUpdate(undefined, "a", "New", 1)).toBeUndefined();
  });

  it("leaves the list unchanged when sessionId does not match", () => {
    const before: SessionListResponse = {
      sessions: [session("a"), session("b")],
      hasMore: false,
    };

    const after = applyTitleUpdate(before, "missing", "New", 9999);

    expect(after?.sessions).toEqual(before.sessions);
  });

  it("does not mutate the input object", () => {
    const before: SessionListResponse = {
      sessions: [session("a")],
      hasMore: false,
    };
    const beforeSnapshot = JSON.parse(JSON.stringify(before));

    applyTitleUpdate(before, "a", "Mutated", 9999);

    expect(before).toEqual(beforeSnapshot);
  });
});

describe("buildGroupedSessionList", () => {
  const now = 10 * 24 * 60 * 60 * 1000;
  const recent = now - 60_000;
  const inactive = now - 8 * 24 * 60 * 60 * 1000;

  it("shows manual and automatic root sessions in separate source views", () => {
    const manual = session("manual", { updatedAt: recent });
    const automatic = session("automatic", {
      spawnSource: "automation",
      updatedAt: recent - 1,
    });
    const child = session("child", {
      parentSessionId: automatic.id,
      spawnSource: "agent",
      updatedAt: recent - 2,
    });

    const manualView = buildGroupedSessionList([manual, automatic, child], {
      sourceFilter: "manual",
      searchQuery: "",
      now,
    });
    const automaticView = buildGroupedSessionList([manual, automatic, child], {
      sourceFilter: "automatic",
      searchQuery: "",
      now,
    });

    expect(manualView.groups[0].activeSessions.map(({ id }) => id)).toEqual([manual.id]);
    expect(automaticView.groups[0].activeSessions.map(({ id }) => id)).toEqual([automatic.id]);
    expect(automaticView.childrenMap.get(automatic.id)?.map(({ id }) => id)).toEqual([child.id]);
  });

  it("groups roots by one, multiple, or no repositories", () => {
    const grouped = buildGroupedSessionList(
      [
        session("single", { updatedAt: recent }),
        session("multiple", {
          updatedAt: recent - 1,
          repositories: [
            { repoOwner: "acme", repoName: "api", repoId: 1, baseBranch: "main" },
            { repoOwner: "acme", repoName: "web", repoId: 2, baseBranch: "main" },
          ],
        }),
        session("none", {
          repoOwner: null,
          repoName: null,
          updatedAt: recent - 2,
        }),
      ],
      { sourceFilter: "manual", searchQuery: "", now }
    );

    expect(grouped.groups.map(({ label }) => label)).toEqual([
      "open-inspect/background-agents",
      "Multiple repositories",
      "No repository",
    ]);
  });

  it("orders groups and sessions by active recency", () => {
    const grouped = buildGroupedSessionList(
      [
        session("older-a", { repoName: "a", updatedAt: recent - 30 }),
        session("newer-a", { repoName: "a", updatedAt: recent - 10 }),
        session("newest-b", { repoName: "b", updatedAt: recent }),
      ],
      { sourceFilter: "manual", searchQuery: "", now }
    );

    expect(grouped.groups.map(({ label }) => label)).toEqual(["open-inspect/b", "open-inspect/a"]);
    expect(grouped.groups[1].activeSessions.map(({ id }) => id)).toEqual(["newer-a", "older-a"]);
  });

  it("keeps inactive roots in active groups and hides inactive-only groups", () => {
    const grouped = buildGroupedSessionList(
      [
        session("active", { repoName: "mixed", updatedAt: recent }),
        session("old", { repoName: "mixed", updatedAt: inactive }),
        session("hidden", { repoName: "inactive-only", updatedAt: inactive - 1 }),
      ],
      { sourceFilter: "manual", searchQuery: "", now }
    );

    expect(grouped.groups.map(({ label }) => label)).toEqual(["open-inspect/mixed"]);
    expect(grouped.groups[0].inactiveSessions.map(({ id }) => id)).toEqual(["old"]);
  });

  it("reports no visible sessions when every group is inactive", () => {
    const grouped = buildGroupedSessionList(
      [session("hidden", { repoName: "inactive-only", updatedAt: inactive })],
      { sourceFilter: "manual", searchQuery: "", now }
    );

    expect(grouped.groups).toEqual([]);
    expect(grouped.hasFilteredSessions).toBe(false);
  });

  it("reveals a matching inactive-only group without promoting child sessions", () => {
    const parent = session("parent", {
      title: "Old parent",
      repoName: "inactive-only",
      updatedAt: inactive,
    });
    const child = session("child", {
      title: "Matching child",
      parentSessionId: parent.id,
      spawnSource: "agent",
      repoName: "different-child-repo",
      updatedAt: inactive + 1,
    });

    const grouped = buildGroupedSessionList([parent, child], {
      sourceFilter: "manual",
      searchQuery: "matching",
      now,
    });

    expect(grouped.groups.map(({ label }) => label)).toEqual(["open-inspect/inactive-only"]);
    expect(grouped.groups[0].inactiveSessions.map(({ id }) => id)).toEqual([parent.id]);
    expect(grouped.childrenMap.get(parent.id)?.map(({ id }) => id)).toEqual([child.id]);
  });

  it("matches a root session directly", () => {
    const grouped = buildGroupedSessionList(
      [session("matching", { title: "Matching root", updatedAt: recent })],
      { sourceFilter: "manual", searchQuery: "matching root", now }
    );

    expect(grouped.groups[0].activeSessions.map(({ id }) => id)).toEqual(["matching"]);
  });

  it("does not parse the automatic title prefix", () => {
    const grouped = buildGroupedSessionList(
      [session("manual", { title: "[Auto] Manual session", updatedAt: recent })],
      { sourceFilter: "automatic", searchQuery: "", now }
    );

    expect(grouped.groups).toEqual([]);
    expect(grouped.hasFilteredSessions).toBe(false);
  });

  it("keeps a child visible when its parent has not loaded yet", () => {
    const orphan = session("orphan", {
      parentSessionId: "parent-on-later-page",
      spawnSource: "agent",
      updatedAt: recent,
    });

    const grouped = buildGroupedSessionList([orphan], {
      sourceFilter: "manual",
      searchQuery: "",
      now,
    });

    expect(grouped.groups[0].activeSessions.map(({ id }) => id)).toEqual([orphan.id]);
  });
});

describe("collectSessionAndDescendantIds", () => {
  it("collects the session plus its children and grandchildren", () => {
    const sessions = [
      session("parent"),
      session("child", { parentSessionId: "parent", spawnSource: "agent" }),
      session("grandchild", { parentSessionId: "child", spawnSource: "agent" }),
      session("unrelated"),
    ];

    const ids = collectSessionAndDescendantIds(sessions, "parent");

    expect(ids).toEqual(new Set(["parent", "child", "grandchild"]));
  });

  it("follows parent links regardless of list ordering", () => {
    // grandchild appears before its parent in the list.
    const sessions = [
      session("grandchild", { parentSessionId: "child" }),
      session("child", { parentSessionId: "parent" }),
      session("parent"),
    ];

    expect(collectSessionAndDescendantIds(sessions, "parent")).toEqual(
      new Set(["parent", "child", "grandchild"])
    );
  });

  it("does not gate on spawn source", () => {
    const sessions = [
      session("parent"),
      session("child", { parentSessionId: "parent", spawnSource: "user" }),
    ];

    expect(collectSessionAndDescendantIds(sessions, "parent")).toEqual(
      new Set(["parent", "child"])
    );
  });

  it("returns just the id when it has no descendants", () => {
    const sessions = [session("a"), session("b", { parentSessionId: "other" })];

    expect(collectSessionAndDescendantIds(sessions, "a")).toEqual(new Set(["a"]));
  });

  it("returns just the id for an empty list", () => {
    // Descendants not currently loaded are reconciled by the next server fetch.
    expect(collectSessionAndDescendantIds([], "x")).toEqual(new Set(["x"]));
  });

  it("terminates on a parent-link cycle", () => {
    // Corrupt data (a→b→a) must not infinite-loop the fixed-point walk.
    const sessions = [
      session("a", { parentSessionId: "b" }),
      session("b", { parentSessionId: "a" }),
    ];

    expect(collectSessionAndDescendantIds(sessions, "a")).toEqual(new Set(["a", "b"]));
  });
});
