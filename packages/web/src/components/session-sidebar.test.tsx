// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SessionSidebar } from "./session-sidebar";

expect.extend(matchers);

const { mockArchiveSessions, mockHook, mockRouterPush, toastMock } = vi.hoisted(() => ({
  mockArchiveSessions: vi.fn(),
  mockHook: vi.fn(),
  mockRouterPush: vi.fn(),
  toastMock: { error: vi.fn() },
}));

vi.mock("@/hooks/use-sidebar-sessions", () => ({ useSidebarSessions: mockHook }));
vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: { name: "Test User", email: "test@example.com" } } }),
  signOut: vi.fn(),
}));
vi.mock("@/hooks/use-media-query", () => ({ useIsMobile: () => false }));
vi.mock("@/hooks/use-environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/session/child",
  useRouter: () => ({ push: mockRouterPush }),
}));
vi.mock("@/lib/archive-session", () => ({
  archiveSession: vi.fn(),
  archiveSessions: mockArchiveSessions,
}));
vi.mock("sonner", () => ({ toast: toastMock }));

function session(id: string, title: string, parentSessionId: string | null = null) {
  return {
    id,
    title,
    repoOwner: "open-inspect",
    repoName: "open-inspect",
    model: "test-model",
    reasoningEffort: null,
    baseBranch: "main",
    status: "active" as const,
    parentSessionId,
    spawnSource: parentSessionId ? ("agent" as const) : ("user" as const),
    spawnDepth: parentSessionId ? 1 : 0,
    automationId: null,
    automationRunId: null,
    scmLogin: "octocat",
    userId: "user_test",
    totalCost: 0,
    activeDurationMs: 0,
    messageCount: 0,
    prCount: 0,
    environmentId: null,
    readState: { latestMessageId: null, unread: false } as const,
    createdAt: 1,
    updatedAt: 2,
  };
}

const noPagination = {
  hasMore: false,
  loadingMore: false,
  loadMore: vi.fn(),
  retry: vi.fn(async () => undefined),
};

beforeEach(() => {
  const attention = session("attention", "Needs review");
  const running = session("running", "Implementing inbox");
  const child = session("child", "Checking tests", running.id);
  const recent = { ...session("recent", "Finished work"), status: "completed" as const };
  mockHook.mockReturnValue({
    needsAttention: [attention],
    running: [running],
    recent: [recent],
    childrenMap: new Map([[running.id, [child]]]),
    loading: false,
    sessionsError: undefined,
    refreshSnapshot: vi.fn(async () => undefined),
    sectionPagination: {
      needsAttention: noPagination,
      running: noPagination,
      recent: noPagination,
    },
    sessionCreatorFilter: "all",
    setSessionCreatorFilter: vi.fn(),
    handleSessionArchived: vi.fn(),
    handleSessionsArchived: vi.fn(),
    handleMarkLatestMessageRead: vi.fn(),
    handleMarkUnread: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SessionSidebar", () => {
  it("archives selected roots, keeps child rows out of selection, and redirects from a descendant", async () => {
    const value = mockHook();
    const handleSessionsArchived = vi.fn(async () => undefined);
    mockHook.mockReturnValue({ ...value, handleSessionsArchived });
    mockArchiveSessions.mockResolvedValue([{ kind: "archived", sessionId: "running" }]);
    render(<SessionSidebar />);

    fireEvent.click(screen.getByRole("button", { name: "Select sessions" }));
    expect(screen.getByRole("checkbox", { name: "Select Implementing inbox" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand 1 sub-task" }));
    expect(
      screen.queryByRole("checkbox", { name: "Select Checking tests" })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Implementing inbox" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive selected (1)" }));
    expect(screen.getByRole("heading", { name: "Archive 1 session" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Archive selected" }));

    await vi.waitFor(() =>
      expect(handleSessionsArchived).toHaveBeenCalledWith(new Set(["running"]))
    );
    expect(mockRouterPush).toHaveBeenCalledWith("/");
  });

  it("keeps failed roots selected and shows one failure summary", async () => {
    mockArchiveSessions.mockResolvedValue([
      { kind: "failed", sessionId: "attention", reason: "Denied" },
    ]);
    render(<SessionSidebar />);

    fireEvent.click(screen.getByRole("button", { name: "Select sessions" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Needs review" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive selected (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive selected" }));

    await vi.waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Failed to archive 1 session")
    );
    expect(screen.getByRole("button", { name: "Archive selected (1)" })).toBeInTheDocument();
  });

  it("renders server-classified sections and nested descendants", () => {
    render(<SessionSidebar />);

    expect(screen.getByRole("heading", { name: "Needs attention" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Running" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recent" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand 1 sub-task" }));
    expect(screen.getByText("Checking tests")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Signed in as Test User" })).toBeInTheDocument();
  });

  it("loads more only in the requested section", () => {
    const value = mockHook();
    const loadMoreRunning = vi.fn();
    mockHook.mockReturnValue({
      ...value,
      sectionPagination: {
        ...value.sectionPagination,
        running: { hasMore: true, loadingMore: false, loadMore: loadMoreRunning },
      },
    });
    render(<SessionSidebar />);

    fireEvent.click(screen.getByRole("button", { name: "Load more running" }));
    expect(loadMoreRunning).toHaveBeenCalledOnce();
  });

  it("keeps archived sessions accessible", () => {
    render(<SessionSidebar />);
    expect(screen.getByRole("link", { name: /Archived/ })).toHaveAttribute(
      "href",
      "/settings?tab=data-controls"
    );
  });

  it("shows a retry action when one category fails", () => {
    const value = mockHook();
    const retry = vi.fn(async () => undefined);
    mockHook.mockReturnValue({
      ...value,
      sessionsError: new Error("attention unavailable"),
      sectionPagination: {
        ...value.sectionPagination,
        needsAttention: { ...noPagination, error: new Error("attention unavailable"), retry },
      },
    });
    render(<SessionSidebar />);

    expect(screen.getByText("Unable to load needs attention")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { name: "Running" })).toBeInTheDocument();
  });

  it("surfaces a retryable error when the initial snapshot fails", () => {
    const value = mockHook();
    const refreshSnapshot = vi.fn(async () => undefined);
    mockHook.mockReturnValue({
      ...value,
      needsAttention: [],
      running: [],
      recent: [],
      childrenMap: new Map(),
      sessionsError: new Error("snapshot unavailable"),
      refreshSnapshot,
    });
    render(<SessionSidebar />);

    expect(screen.getByText("Unable to load sessions")).toBeInTheDocument();
    expect(screen.queryByText("No sessions yet")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refreshSnapshot).toHaveBeenCalledOnce();
  });

  it("groups by repo, splits manual from automatic, nests children, and marks unread", () => {
    const value = mockHook();
    const webManual = {
      ...session("web-manual", "Manual web work"),
      repoOwner: "acme",
      repoName: "web",
      readState: { latestMessageId: "m1", unread: true } as const,
    };
    const webChild = {
      ...session("web-child", "Nested subtask", webManual.id),
      repoOwner: "acme",
      repoName: "web",
    };
    const webAuto = {
      ...session("web-auto", "Scheduled sweep"),
      repoOwner: "acme",
      repoName: "web",
      spawnSource: "automation" as const,
    };
    const apiManual = {
      ...session("api-manual", "API work"),
      repoOwner: "acme",
      repoName: "api",
    };
    mockHook.mockReturnValue({
      ...value,
      needsAttention: [webManual, webAuto, apiManual],
      running: [],
      recent: [],
      childrenMap: new Map([[webManual.id, [webChild]]]),
    });
    render(<SessionSidebar />);

    const webGroup = screen.getByRole("group", { name: "acme/web" });
    expect(webGroup).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "acme/api" })).toBeInTheDocument();
    expect(within(webGroup).getByText("Manual")).toBeInTheDocument();
    expect(within(webGroup).getByText("Automatic")).toBeInTheDocument();
    expect(screen.getByText("Unread")).toBeInTheDocument();

    expect(screen.queryByText("Nested subtask")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand 1 sub-task" }));
    expect(screen.getByText("Nested subtask")).toBeInTheDocument();
  });

  it("keeps children hidden until the parent is expanded", () => {
    const value = mockHook();
    const parent = session("parent-one", "Parent session");
    const child = session("child-one", "Hidden child", parent.id);
    mockHook.mockReturnValue({
      ...value,
      needsAttention: [],
      running: [],
      recent: [parent],
      childrenMap: new Map([[parent.id, [child]]]),
    });
    render(<SessionSidebar />);

    expect(screen.getByText("Parent session")).toBeInTheDocument();
    expect(screen.queryByText("Hidden child")).not.toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: "Expand 1 sub-task" });
    fireEvent.click(toggle);
    expect(screen.getByText("Hidden child")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Collapse 1 sub-task" }));
    expect(screen.queryByText("Hidden child")).not.toBeInTheDocument();
  });
});
