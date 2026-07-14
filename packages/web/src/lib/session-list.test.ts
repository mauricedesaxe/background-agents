import { describe, expect, it } from "vitest";
import {
  applyTitleUpdate,
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
