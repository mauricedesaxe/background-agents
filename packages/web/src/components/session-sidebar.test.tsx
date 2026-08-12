// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SWRConfig, useSWRConfig } from "swr";
import { MOBILE_LONG_PRESS_MS, SessionSidebar } from "./session-sidebar";
import {
  buildSessionsPageKey,
  CURRENT_USER_CREATED_BY,
  SIDEBAR_SESSIONS_KEY,
} from "@/lib/session-list";

expect.extend(matchers);

const { mockUseIsMobile } = vi.hoisted(() => ({
  mockUseIsMobile: vi.fn(() => false),
}));

const { mockPush } = vi.hoisted(() => ({
  mockPush: vi.fn(),
}));

const { mockAuthSession } = vi.hoisted(() => ({
  mockAuthSession: {
    user: {
      name: "Test User",
      email: "test@example.com",
    },
  },
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: mockAuthSession }),
  signOut: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: React.ComponentProps<"a">) => (
    <a href={typeof href === "string" ? href : "#"} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/hooks/use-media-query", () => ({
  useIsMobile: mockUseIsMobile,
}));

const { mockUseEnvironments } = vi.hoisted(() => ({
  mockUseEnvironments: vi.fn(() => ({ environments: [] as unknown[], loading: false })),
}));

vi.mock("@/hooks/use-environments", () => ({
  useEnvironments: mockUseEnvironments,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  mockUseIsMobile.mockReturnValue(false);
  mockPush.mockReset();
  mockUseEnvironments.mockReturnValue({ environments: [], loading: false });
});

function createSession(index: number, overrides: Record<string, unknown> = {}) {
  const updatedAt = Date.now() - index;
  return {
    id: `session-${index}`,
    title: `Session ${index}`,
    repoOwner: "open-inspect",
    repoName: "background-agents",
    parentSessionId: null,
    spawnSource: "user",
    spawnDepth: 0,
    status: "active",
    createdAt: updatedAt - 1000,
    updatedAt,
    ...overrides,
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function RevalidateFirstPageButton() {
  const { mutate } = useSWRConfig();
  return (
    <button type="button" onClick={() => void mutate(SIDEBAR_SESSIONS_KEY)}>
      Revalidate first page
    </button>
  );
}

describe("SessionSidebar", () => {
  it("renders the PR status summary on session rows", async () => {
    const now = Date.now();
    const single = createSession(1, {
      updatedAt: now,
      pullRequestSummary: { total: 1, open: 0, draft: 0, merged: 1, closed: 0 },
    });
    const multi = createSession(2, {
      updatedAt: now - 1,
      pullRequestSummary: { total: 3, open: 1, draft: 1, merged: 1, closed: 0 },
    });
    const none = createSession(3, { updatedAt: now - 2 });

    render(
      <SWRConfig
        value={{
          fallback: {
            [SIDEBAR_SESSIONS_KEY]: {
              sessions: [single, multi, none],
              hasMore: false,
            },
          },
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    // GitHub-style state icon next to the title: merged for the single-PR
    // session, open (dominant bucket) for the multi-PR session, none without
    // tracked PRs.
    expect(await screen.findByTestId("pr-state-merged")).toHaveClass(
      "text-[#8250df]",
      "dark:text-[#a371f7]"
    );
    expect(screen.getByTestId("pr-state-open")).toHaveClass(
      "text-[#1f883d]",
      "dark:text-[#3fb950]"
    );
    expect(screen.queryAllByTestId(/^pr-state-/)).toHaveLength(2);

    // PR state is conveyed by the title icon without repeating the summary in
    // the lower repository and branch metadata.
    expect(screen.getByText("Session 1").closest("a")).not.toHaveTextContent("PR merged");
    expect(screen.getByText("Session 2").closest("a")).not.toHaveTextContent("3 PRs · 2 open");
  });

  it("collapses descendants by default and expands them from the parent", async () => {
    const now = Date.now();
    const parent = createSession(1, { updatedAt: now });
    const child = createSession(2, {
      title: "Child session",
      parentSessionId: parent.id,
      spawnSource: "agent",
      spawnDepth: 1,
      updatedAt: now - 1,
    });
    const grandchild = createSession(3, {
      title: "Grandchild session",
      parentSessionId: child.id,
      spawnSource: "agent",
      spawnDepth: 2,
      updatedAt: now - 2,
    });

    render(
      <SWRConfig
        value={{
          fallback: {
            [SIDEBAR_SESSIONS_KEY]: {
              sessions: [parent, child, grandchild],
              hasMore: false,
            },
          },
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    expect(await screen.findByText("Session 1")).toBeInTheDocument();
    expect(screen.queryByText("Child session")).not.toBeInTheDocument();
    expect(screen.queryByText("Grandchild session")).not.toBeInTheDocument();

    const expandButton = screen.getByRole("button", {
      name: "Expand 2 child sessions for Session 1, 2 active",
    });
    expect(expandButton).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(expandButton);

    expect(screen.getByText("Child session")).toBeInTheDocument();
    expect(screen.getByText("Grandchild session")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Collapse 2 child sessions for Session 1, 2 active",
      })
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("rolls child activity up to a collapsed parent", async () => {
    const parent = createSession(1);
    const completedChild = createSession(2, {
      parentSessionId: parent.id,
      spawnSource: "agent",
      status: "completed",
    });
    const activeGrandchild = createSession(3, {
      parentSessionId: completedChild.id,
      spawnSource: "agent",
      status: "active",
    });

    render(
      <SWRConfig
        value={{
          fallback: {
            [SIDEBAR_SESSIONS_KEY]: {
              sessions: [parent, completedChild, activeGrandchild],
              hasMore: false,
            },
          },
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    expect(
      await screen.findByRole("button", {
        name: "Expand 2 child sessions for Session 1, 1 active",
      })
    ).toBeInTheDocument();
    expect(screen.queryByText("Session 2")).not.toBeInTheDocument();
  });

  it("reveals matching descendants while searching", async () => {
    const parent = createSession(1);
    const firstChild = createSession(2, {
      title: "Needle child",
      parentSessionId: parent.id,
      spawnSource: "agent",
    });
    const secondChild = createSession(3, {
      title: "Another match",
      parentSessionId: parent.id,
      spawnSource: "agent",
    });

    render(
      <SWRConfig
        value={{
          fallback: {
            [SIDEBAR_SESSIONS_KEY]: {
              sessions: [parent, firstChild, secondChild],
              hasMore: false,
            },
          },
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    expect(await screen.findByText("Session 1")).toBeInTheDocument();
    expect(screen.queryByText("Needle child")).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search sessions..."), {
      target: { value: "Needle child" },
    });

    expect(screen.getByText("Needle child")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Collapse 1 child session/ })).toHaveAttribute(
      "aria-expanded",
      "true"
    );

    fireEvent.click(screen.getByRole("button", { name: /Collapse 1 child session/ }));
    expect(screen.queryByText("Needle child")).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search sessions..."), {
      target: { value: "Another match" },
    });

    expect(screen.getByText("Another match")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Collapse 1 child session/ })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
  });

  it("shows unread sessions and rolls unread children up to their parent", async () => {
    const parent = createSession(1, { unread: false });
    const child = createSession(2, {
      title: "Unread child",
      parentSessionId: parent.id,
      spawnSource: "agent",
      unread: true,
    });

    render(
      <SWRConfig
        value={{
          fallback: {
            [SIDEBAR_SESSIONS_KEY]: { sessions: [parent, child], hasMore: false },
          },
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    expect(await screen.findByTestId(`session-unread-${parent.id}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Expand 1 child session/ }));
    expect(screen.getByTestId(`session-unread-${child.id}`)).toBeInTheDocument();
  });

  it("defaults to manual sessions and switches to automatic roots with their children", async () => {
    const manual = createSession(1, { title: "Manual session" });
    const automatic = createSession(2, {
      title: "Scheduled session",
      spawnSource: "automation",
    });
    const child = createSession(3, {
      title: "Automatic child",
      parentSessionId: automatic.id,
      spawnSource: "agent",
    });

    render(
      <SWRConfig
        value={{
          fallback: {
            [SIDEBAR_SESSIONS_KEY]: { sessions: [manual, automatic, child], hasMore: false },
          },
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    expect(await screen.findByText("Manual session")).toBeInTheDocument();
    expect(screen.queryByText("Scheduled session")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Manual" })).toHaveAttribute("data-state", "on");

    fireEvent.click(screen.getByRole("radio", { name: "Automatic" }));

    expect(screen.getByText("Scheduled session")).toBeInTheDocument();
    expect(screen.queryByText("Automatic child")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Expand 1 child session/ }));
    expect(screen.getByText("Automatic child")).toBeInTheDocument();
    expect(screen.queryByText("Manual session")).not.toBeInTheDocument();
  });

  it("groups top-level sessions by repository context", async () => {
    const sessions = [
      createSession(1, { title: "Single repository" }),
      createSession(2, {
        title: "Multiple repositories session",
        repositories: [
          { repoOwner: "acme", repoName: "api", repoId: 1, baseBranch: "main" },
          { repoOwner: "acme", repoName: "web", repoId: 2, baseBranch: "main" },
        ],
      }),
      createSession(3, {
        title: "Repository-less session",
        repoOwner: null,
        repoName: null,
      }),
    ];

    render(
      <SWRConfig
        value={{
          fallback: { [SIDEBAR_SESSIONS_KEY]: { sessions, hasMore: false } },
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    expect(
      await screen.findByRole("heading", { name: "open-inspect/background-agents" })
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Multiple repositories" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No repository" })).toBeInTheDocument();
    expect(screen.getByText("acme/api, acme/web")).toBeInTheDocument();
  });

  it("collapses inactive sessions and hides inactive-only groups until search matches", async () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const sessions = [
      createSession(1, { title: "Active session", repoName: "mixed" }),
      createSession(2, {
        title: "Old mixed session",
        repoName: "mixed",
        updatedAt: eightDaysAgo,
      }),
      createSession(3, {
        title: "Dormant only",
        repoName: "dormant",
        updatedAt: eightDaysAgo - 1,
      }),
    ];

    render(
      <SWRConfig
        value={{
          fallback: { [SIDEBAR_SESSIONS_KEY]: { sessions, hasMore: false } },
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    expect(await screen.findByText("Active session")).toBeInTheDocument();
    expect(screen.queryByText("Old mixed session")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "open-inspect/dormant" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Inactive (1)" }));
    expect(screen.getByText("Old mixed session")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search sessions..."), {
      target: { value: "Dormant only" },
    });

    expect(screen.getByRole("heading", { name: "open-inspect/dormant" })).toBeInTheDocument();
    expect(screen.getByText("Dormant only")).toBeInTheDocument();
  });

  it("keeps the source filter active while searching inactive sessions", async () => {
    const automatic = createSession(1, {
      title: "Dormant automation",
      spawnSource: "automation",
      updatedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
    });

    render(
      <SWRConfig
        value={{
          fallback: { [SIDEBAR_SESSIONS_KEY]: { sessions: [automatic], hasMore: false } },
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    fireEvent.change(screen.getByPlaceholderText("Search sessions..."), {
      target: { value: "Dormant automation" },
    });
    expect(screen.getByText("No matching sessions")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Automatic" }));
    expect(await screen.findByText("Dormant automation")).toBeInTheDocument();
  });

  it("shows an empty state for an unmatched search and restores sessions when cleared", async () => {
    render(
      <SWRConfig
        value={{
          fallback: { [SIDEBAR_SESSIONS_KEY]: { sessions: [createSession(1)], hasMore: false } },
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    expect(await screen.findByText("Session 1")).toBeInTheDocument();

    const searchInput = screen.getByPlaceholderText("Search sessions...");
    fireEvent.change(searchInput, { target: { value: "missing" } });

    expect(screen.getByText("No matching sessions")).toBeInTheDocument();
    expect(screen.queryByText("Session 1")).not.toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: "" } });

    expect(screen.getByText("Session 1")).toBeInTheDocument();
    expect(screen.queryByText("No matching sessions")).not.toBeInTheDocument();
  });

  it("keeps the genuine empty-session state distinct from empty search results", () => {
    render(
      <SWRConfig
        value={{
          fallback: { [SIDEBAR_SESSIONS_KEY]: { sessions: [], hasMore: false } },
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    fireEvent.change(screen.getByPlaceholderText("Search sessions..."), {
      target: { value: "missing" },
    });

    expect(screen.getByText("No sessions yet")).toBeInTheDocument();
    expect(screen.queryByText("No matching sessions")).not.toBeInTheDocument();
  });

  it("keeps the session-loading failure distinct from empty search results", async () => {
    render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          fetcher: async () => {
            throw new Error("Failed to load sessions");
          },
          shouldRetryOnError: false,
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    expect(await screen.findByText("Unable to load sessions")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search sessions..."), {
      target: { value: "missing" },
    });

    expect(screen.getByText("Unable to load sessions")).toBeInTheDocument();
    expect(screen.queryByText("No matching sessions")).not.toBeInTheDocument();
  });

  it("loads the next page when scrolled near the bottom", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => createSession(index + 1));
    const secondPage = Array.from({ length: 5 }, (_, index) => createSession(index + 51));
    const secondPageKey = buildSessionsPageKey({
      excludeStatus: "archived",
      mode: "tree",
      cursor: "page-1-cursor",
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url === SIDEBAR_SESSIONS_KEY) {
        return jsonResponse({ sessions: firstPage, hasMore: true, nextCursor: "page-1-cursor" });
      }

      if (url === secondPageKey) {
        return jsonResponse({ sessions: secondPage, hasMore: false, nextCursor: null });
      }

      throw new Error(`Unexpected fetch for ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          dedupingInterval: 0,
          revalidateOnFocus: false,
          fetcher: async (url: string) => {
            const response = await fetch(url);
            return response.json();
          },
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    expect(await screen.findByText("Session 1")).toBeInTheDocument();

    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    let scrollTop = 0;

    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 2000,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 400,
    });
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTop = value;
      },
    });

    scrollTop = 1705;
    fireEvent.scroll(scrollContainer);

    expect(await screen.findByText("Session 55")).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(secondPageKey);
    });
  });

  it("continues past a page containing only ancestor duplicates", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => createSession(index + 1));
    const duplicatePageKey = buildSessionsPageKey({
      excludeStatus: "archived",
      mode: "tree",
      cursor: "page-1-cursor",
    });
    const finalPageKey = buildSessionsPageKey({
      excludeStatus: "archived",
      mode: "tree",
      cursor: "page-2-cursor",
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === duplicatePageKey) {
        return jsonResponse({
          sessions: [...firstPage],
          hasMore: true,
          nextCursor: "page-2-cursor",
        });
      }
      if (url === finalPageKey) {
        return jsonResponse({
          sessions: [createSession(51, { title: "Older unique session" })],
          hasMore: false,
          nextCursor: null,
        });
      }
      throw new Error(`Unexpected fetch for ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          fallback: {
            [SIDEBAR_SESSIONS_KEY]: {
              sessions: firstPage,
              hasMore: true,
              nextCursor: "page-1-cursor",
            },
          },
          dedupingInterval: 0,
          revalidateOnFocus: false,
          revalidateOnMount: false,
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    expect(await screen.findByText("Session 1")).toBeInTheDocument();

    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(scrollContainer, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(scrollContainer, "scrollTop", { configurable: true, value: 1705 });
    fireEvent.scroll(scrollContainer);

    expect(await screen.findByText("Older unique session")).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(duplicatePageKey);
      expect(fetchMock).toHaveBeenCalledWith(finalPageKey);
    });
  });

  it("keeps closure children classified after pagination and first-page revalidation", async () => {
    const now = Date.now();
    const parent = createSession(1, { title: "Closure parent", updatedAt: now - 10_000 });
    const child = createSession(2, {
      title: "Recent child",
      parentSessionId: parent.id,
      spawnSource: "agent",
      spawnDepth: 1,
      updatedAt: now,
    });
    const firstPage = {
      sessions: [child, parent],
      hasMore: true,
      nextCursor: "tree-page-1",
    };
    const secondPageKey = buildSessionsPageKey({
      excludeStatus: "archived",
      mode: "tree",
      cursor: "tree-page-1",
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === SIDEBAR_SESSIONS_KEY) {
        return jsonResponse({ ...firstPage, sessions: [...firstPage.sessions] });
      }
      if (String(input) === secondPageKey) {
        return jsonResponse({
          sessions: [parent, createSession(3, { title: "Second-page root" })],
          hasMore: false,
          nextCursor: null,
        });
      }
      throw new Error(`Unexpected fetch for ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          fallback: { [SIDEBAR_SESSIONS_KEY]: firstPage },
          dedupingInterval: 0,
          revalidateOnFocus: false,
          revalidateOnMount: false,
          fetcher: async (url: string) => {
            const response = await fetch(url);
            return response.json();
          },
        }}
      >
        <SessionSidebar />
        <RevalidateFirstPageButton />
      </SWRConfig>
    );

    expect(await screen.findByText("Closure parent")).toBeInTheDocument();
    expect(screen.queryByText("Recent child")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Expand 1 child session for Closure parent, 1 active",
      })
    ).toBeInTheDocument();

    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(scrollContainer, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(scrollContainer, "scrollTop", { configurable: true, value: 1705 });
    fireEvent.scroll(scrollContainer);

    expect(await screen.findByText("Second-page root")).toBeInTheDocument();
    expect(screen.getAllByText("Closure parent")).toHaveLength(1);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Expand 1 child session for Closure parent, 1 active",
      })
    );
    expect(await screen.findByText("Recent child")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Revalidate first page" }));

    await waitFor(() => expect(screen.queryByText("Second-page root")).not.toBeInTheDocument());
    expect(screen.getAllByText("Closure parent")).toHaveLength(1);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Expand 1 child session for Closure parent, 1 active",
      })
    );
    expect(await screen.findByText("Recent child")).toBeInTheDocument();
  });

  it("loads another page when the selected source leaves the viewport empty", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => createSession(index + 1));
    const secondPageKey = buildSessionsPageKey({
      excludeStatus: "archived",
      mode: "tree",
      cursor: "page-1-cursor",
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url === SIDEBAR_SESSIONS_KEY) {
        return jsonResponse({ sessions: firstPage, hasMore: true, nextCursor: "page-1-cursor" });
      }

      if (url === secondPageKey) {
        return jsonResponse({
          sessions: [
            createSession(51, {
              title: "Automatic on page two",
              spawnSource: "automation",
            }),
          ],
          hasMore: false,
          nextCursor: null,
        });
      }

      throw new Error(`Unexpected fetch for ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          dedupingInterval: 0,
          revalidateOnFocus: false,
          fetcher: async (url: string) => {
            const response = await fetch(url);
            return response.json();
          },
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );
    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    let scrollHeight = 800;
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 400,
    });

    expect(await screen.findByText("Session 1")).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).not.toHaveBeenCalledWith(secondPageKey);

    scrollHeight = 400;

    fireEvent.click(screen.getByRole("radio", { name: "Automatic" }));

    expect(await screen.findByText("Automatic on page two")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(secondPageKey);
  });

  it("filters sessions to the current user when Mine is selected", async () => {
    const mineKey = buildSessionsPageKey({
      excludeStatus: "archived",
      createdBy: [CURRENT_USER_CREATED_BY],
      mode: "tree",
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url === SIDEBAR_SESSIONS_KEY) {
        return jsonResponse({ sessions: [createSession(1)], hasMore: false });
      }

      if (url === mineKey) {
        return jsonResponse({
          sessions: [
            createSession(2, { title: "Mine only" }),
            createSession(3, { title: "Mine automation", spawnSource: "automation" }),
          ],
          hasMore: false,
        });
      }

      throw new Error(`Unexpected fetch for ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          dedupingInterval: 0,
          revalidateOnFocus: false,
          fetcher: async (url: string) => {
            const response = await fetch(url);
            return response.json();
          },
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    expect(await screen.findByText("Session 1")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Mine"));

    expect(await screen.findByText("Mine only")).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(mineKey);
    });
    expect(screen.queryByText("Session 1")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Automatic" }));
    expect(screen.getByText("Mine automation")).toBeInTheDocument();
    expect(screen.queryByText("Mine only")).not.toBeInTheDocument();
  });

  it("matches non-primary repository members in the sidebar search", async () => {
    const session = createSession(1, {
      repositories: [
        { repoOwner: "open-inspect", repoName: "background-agents", repoId: 1, baseBranch: "main" },
        { repoOwner: "acme", repoName: "api", repoId: 2, baseBranch: "main" },
      ],
    });

    render(
      <SWRConfig
        value={{
          fallback: { [SIDEBAR_SESSIONS_KEY]: { sessions: [session], hasMore: false } },
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    expect(await screen.findByText("Session 1")).toBeInTheDocument();

    const searchInput = screen.getByPlaceholderText("Search sessions...");
    fireEvent.change(searchInput, { target: { value: "acme/api" } });

    expect(screen.getByText("Session 1")).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: "acme/docs" } });

    expect(screen.queryByText("Session 1")).not.toBeInTheDocument();
    expect(screen.getByText("No matching sessions")).toBeInTheDocument();
  });

  it("shows the environment name on cards for environment-launched sessions", async () => {
    mockUseEnvironments.mockReturnValue({
      environments: [{ id: "env_1", name: "Full stack" }],
      loading: false,
    });

    const sessions = [
      createSession(1, { environmentId: "env_1" }),
      // Deleted environment: the chip is dropped rather than showing a raw id.
      createSession(2, { environmentId: "env_gone" }),
    ];

    render(
      <SWRConfig
        value={{
          fallback: { [SIDEBAR_SESSIONS_KEY]: { sessions, hasMore: false } },
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    expect(await screen.findByText("Session 1")).toBeInTheDocument();
    expect(screen.getByText("Full stack")).toBeInTheDocument();
    expect(screen.queryByText("env_gone")).not.toBeInTheDocument();
  });

  it("ignores stale load-more results after the creator filter changes", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => createSession(index + 1));
    const allNextPageKey = buildSessionsPageKey({
      excludeStatus: "archived",
      mode: "tree",
      cursor: "all-page-1-cursor",
    });
    const mineKey = buildSessionsPageKey({
      excludeStatus: "archived",
      createdBy: [CURRENT_USER_CREATED_BY],
      mode: "tree",
    });
    let resolveAllNextPage!: (response: Response) => void;
    const allNextPage = new Promise<Response>((resolve) => {
      resolveAllNextPage = resolve;
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url === SIDEBAR_SESSIONS_KEY) {
        return jsonResponse({
          sessions: firstPage,
          hasMore: true,
          nextCursor: "all-page-1-cursor",
        });
      }

      if (url === allNextPageKey) {
        return allNextPage;
      }

      if (url === mineKey) {
        return jsonResponse({
          sessions: [createSession(99, { title: "Mine only" })],
          hasMore: false,
        });
      }

      throw new Error(`Unexpected fetch for ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          dedupingInterval: 0,
          revalidateOnFocus: false,
          fetcher: async (url: string) => {
            const response = await fetch(url);
            return response.json();
          },
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    expect(await screen.findByText("Session 1")).toBeInTheDocument();

    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 2000,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 400,
    });
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 1705,
    });

    fireEvent.scroll(scrollContainer);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(allNextPageKey);
    });

    fireEvent.click(screen.getByText("Mine"));
    expect(await screen.findByText("Mine only")).toBeInTheDocument();

    await act(async () => {
      resolveAllNextPage(
        jsonResponse({
          sessions: [createSession(51, { title: "Stale page" })],
          hasMore: false,
        })
      );
      await allNextPage;
    });

    expect(screen.queryByText("Stale page")).not.toBeInTheDocument();
    expect(screen.getByText("Mine only")).toBeInTheDocument();
  });

  it("navigates directly on mobile tap without opening rename actions", async () => {
    mockUseIsMobile.mockReturnValue(true);
    const onSessionSelect = vi.fn();

    render(
      <SWRConfig
        value={{
          fallback: { [SIDEBAR_SESSIONS_KEY]: { sessions: [createSession(1)], hasMore: false } },
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar onSessionSelect={onSessionSelect} />
      </SWRConfig>
    );

    const link = await screen.findByRole("link", { name: /session 1/i });
    fireEvent.click(link);

    expect(screen.queryByText("Rename")).not.toBeInTheDocument();
    expect(onSessionSelect).toHaveBeenCalledTimes(1);
  });

  it("closes the sidebar on mobile when using non-session navigation links", () => {
    mockUseIsMobile.mockReturnValue(true);
    const onSessionSelect = vi.fn();

    render(
      <SWRConfig
        value={{
          fallback: { [SIDEBAR_SESSIONS_KEY]: { sessions: [createSession(1)], hasMore: false } },
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar onSessionSelect={onSessionSelect} />
      </SWRConfig>
    );

    fireEvent.click(screen.getByRole("link", { name: /^inspect$/i }));
    fireEvent.click(screen.getByTitle("Settings"));
    fireEvent.click(screen.getByRole("link", { name: /automations/i }));
    fireEvent.click(screen.getByRole("link", { name: /analytics/i }));

    expect(onSessionSelect).toHaveBeenCalledTimes(4);
  });

  it("opens rename actions on mobile long press", async () => {
    mockUseIsMobile.mockReturnValue(true);

    render(
      <SWRConfig
        value={{
          fallback: { [SIDEBAR_SESSIONS_KEY]: { sessions: [createSession(1)], hasMore: false } },
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    const link = await screen.findByRole("link", { name: /session 1/i });
    vi.useFakeTimers();
    fireEvent.touchStart(link, { touches: [{ clientX: 20, clientY: 20 }] });
    act(() => {
      vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS);
    });

    expect(screen.getByText("Rename")).toBeInTheDocument();
    expect(screen.getByText("Archive")).toBeInTheDocument();
  });

  it("sends the mark-read action from the mobile menu", async () => {
    mockUseIsMobile.mockReturnValue(true);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/sessions/session-1/read-state" && init?.method === "PATCH") {
        return jsonResponse({ sessionId: "session-1", unread: false });
      }
      throw new Error(`Unexpected fetch for ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SWRConfig
        value={{
          fallback: {
            [SIDEBAR_SESSIONS_KEY]: {
              sessions: [createSession(1, { unread: true })],
              hasMore: false,
            },
          },
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    const link = await screen.findByRole("link", { name: /session 1/i });
    vi.useFakeTimers();
    fireEvent.touchStart(link, { touches: [{ clientX: 20, clientY: 20 }] });
    act(() => vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS));
    vi.useRealTimers();
    fireEvent.click(screen.getByText("Mark as read"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1/read-state", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark_read" }),
      });
    });
  });

  it("opens unread child actions on mobile long press", async () => {
    mockUseIsMobile.mockReturnValue(true);
    const parent = createSession(1);
    const child = createSession(2, {
      title: "Unread child",
      parentSessionId: parent.id,
      spawnSource: "agent",
      unread: true,
    });

    render(
      <SWRConfig
        value={{
          fallback: {
            [SIDEBAR_SESSIONS_KEY]: { sessions: [parent, child], hasMore: false },
          },
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    fireEvent.click(await screen.findByRole("button", { name: /Expand 1 child session/ }));
    const link = await screen.findByRole("link", { name: /unread child/i });
    vi.useFakeTimers();
    fireEvent.touchStart(link, { touches: [{ clientX: 20, clientY: 20 }] });
    act(() => vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS));

    expect(screen.getByText("Mark as read")).toBeInTheDocument();
  });

  it("archives a session from the sidebar actions menu", async () => {
    mockUseIsMobile.mockReturnValue(true);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/sessions/session-1/archive" && init?.method === "POST") {
        return jsonResponse({ ok: true });
      }

      throw new Error(`Unexpected fetch for ${String(input)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <SWRConfig
        value={{
          fallback: { [SIDEBAR_SESSIONS_KEY]: { sessions: [createSession(1)], hasMore: false } },
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    const link = await screen.findByRole("link", { name: /session 1/i });
    vi.useFakeTimers();
    fireEvent.touchStart(link, { touches: [{ clientX: 20, clientY: 20 }] });
    act(() => {
      vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS);
    });
    vi.useRealTimers();

    fireEvent.click(screen.getByText("Archive"));
    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1/archive", { method: "POST" });
    });
  });

  it("keeps the session in the sidebar when archiving fails", async () => {
    mockUseIsMobile.mockReturnValue(true);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/sessions/session-1/archive" && init?.method === "POST") {
        return new Response(null, { status: 500 });
      }

      throw new Error(`Unexpected fetch for ${String(input)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <SWRConfig
        value={{
          fallback: { [SIDEBAR_SESSIONS_KEY]: { sessions: [createSession(1)], hasMore: false } },
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    const link = await screen.findByRole("link", { name: /session 1/i });
    vi.useFakeTimers();
    fireEvent.touchStart(link, { touches: [{ clientX: 20, clientY: 20 }] });
    act(() => {
      vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS);
    });
    vi.useRealTimers();

    fireEvent.click(screen.getByText("Archive"));
    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1/archive", { method: "POST" });
    });

    expect(screen.getByRole("link", { name: /session 1/i })).toBeInTheDocument();
  });
});
