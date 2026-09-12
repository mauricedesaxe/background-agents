// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionItem } from "@/hooks/use-sidebar-sessions";
import { ChildSessionListItem, SessionListItem } from "./session-list-item";

expect.extend(matchers);

const mocks = vi.hoisted(() => ({
  allowedPermissions: new Set<string>(),
}));

vi.mock("next/link", () => ({
  default: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a>,
}));

vi.mock("@/hooks/use-session-rename", () => ({
  useSessionRename: () => ({ optimisticTitle: null, renameSession: vi.fn() }),
}));

vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    hasPermission: (permission: string) => mocks.allowedPermissions.has(permission),
  }),
}));

beforeEach(() => {
  mocks.allowedPermissions = new Set();
});

afterEach(() => {
  cleanup();
});

function session(unread = false): SessionItem {
  return {
    id: "session-1",
    title: "Session one",
    repoOwner: null,
    repoName: null,
    baseBranch: null,
    status: "active",
    parentSessionId: null,
    spawnSource: "user",
    environmentId: null,
    createdAt: 1,
    updatedAt: 2,
    readState: unread
      ? { latestMessageId: "message-1", version: 1, unread: true }
      : { latestMessageId: null, version: 0, unread: false },
  };
}

function renderItem(unread = false) {
  render(
    <SessionListItem
      session={session(unread)}
      isActive={false}
      isMobile={false}
      onArchive={vi.fn()}
      onMarkLatestMessageRead={vi.fn()}
      onMarkUnread={vi.fn()}
    />
  );
}

it("fails closed when sessions.lifecycle is denied", () => {
  renderItem();

  expect(screen.queryByRole("button", { name: "Session actions" })).not.toBeInTheDocument();
});

it("shows rename and archive actions when sessions.lifecycle is allowed", async () => {
  mocks.allowedPermissions.add("sessions.lifecycle");
  renderItem();

  fireEvent.pointerDown(screen.getByRole("button", { name: "Session actions" }), {
    button: 0,
    ctrlKey: false,
  });

  expect(await screen.findByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "Archive" })).toBeInTheDocument();
});

it("keeps mark-as-read available without sessions.lifecycle", async () => {
  renderItem(true);

  fireEvent.pointerDown(screen.getByRole("button", { name: "Session actions" }), {
    button: 0,
    ctrlKey: false,
  });

  expect(await screen.findByRole("menuitem", { name: "Mark as read" })).toBeInTheDocument();
  expect(screen.queryByRole("menuitem", { name: "Mark as unread" })).not.toBeInTheDocument();
  expect(screen.queryByRole("menuitem", { name: "Rename" })).not.toBeInTheDocument();
  expect(screen.queryByRole("menuitem", { name: "Archive" })).not.toBeInTheDocument();
});

it("offers mark-as-unread for a read session with a latest message", async () => {
  const onMarkUnread = vi.fn();
  render(
    <SessionListItem
      session={{
        ...session(),
        readState: { latestMessageId: "message-1", version: 1, unread: false },
      }}
      isActive={false}
      isMobile={false}
      onArchive={vi.fn()}
      onMarkLatestMessageRead={vi.fn()}
      onMarkUnread={onMarkUnread}
    />
  );

  fireEvent.pointerDown(screen.getByRole("button", { name: "Session actions" }), {
    button: 0,
    ctrlKey: false,
  });

  expect(await screen.findByRole("menuitem", { name: "Mark as unread" })).toBeInTheDocument();
  expect(screen.queryByRole("menuitem", { name: "Mark as read" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("menuitem", { name: "Mark as unread" }));
  expect(onMarkUnread).toHaveBeenCalledExactlyOnceWith("session-1");
});

it("keeps an open child session menu trigger measurable", async () => {
  render(
    <ChildSessionListItem
      session={{ ...session(true), parentSessionId: "parent-session" }}
      isActive={false}
      isMobile={false}
      depth={1}
      onMarkLatestMessageRead={vi.fn()}
      onMarkUnread={vi.fn()}
    />
  );

  const trigger = screen.getByRole("button", { name: "Session actions" });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });

  expect(await screen.findByRole("menuitem", { name: "Mark as read" })).toBeInTheDocument();
  expect(trigger).toHaveAttribute("data-state", "open");
  expect(trigger).toHaveClass("flex");
  expect(trigger).not.toHaveClass("hidden");
});
