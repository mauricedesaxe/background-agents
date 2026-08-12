// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SessionHeader } from "./session-header";

expect.extend(matchers);

afterEach(cleanup);

vi.mock("@/components/sidebar-layout", () => ({
  CollapsedSidebarControls: () => <div data-testid="collapsed-sidebar-controls" />,
  useSidebarContext: () => ({
    isOpen: false,
    toggle: vi.fn(),
  }),
}));

describe("SessionHeader", () => {
  it("renders no-repository fallback data as loaded while socket state is absent", () => {
    render(
      <SessionHeader
        sessionState={null}
        sandboxError={null}
        fallbackSessionInfo={{ repoOwner: null, repoName: null, title: "Incident sweep" }}
        connected={false}
        connecting={true}
        participants={[]}
        isDetailsOpen={false}
        detailsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        renameSession={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Incident sweep" })).toBeInTheDocument();
    expect(screen.getByText("No repository")).toBeInTheDocument();
    expect(screen.queryByText("Loading session...")).not.toBeInTheDocument();
  });

  it("keeps session identity shrinkable beside collapsed controls", () => {
    render(
      <SessionHeader
        sessionState={null}
        sandboxError={null}
        fallbackSessionInfo={{
          repoOwner: "open-inspect",
          repoName: "a-repository-name-that-does-not-fit-on-a-narrow-phone",
          title: "A session title that also needs room",
        }}
        connected={true}
        connecting={false}
        participants={[]}
        isDetailsOpen={false}
        detailsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        renameSession={vi.fn()}
      />
    );

    expect(screen.getByTestId("collapsed-sidebar-controls").parentElement).toHaveClass(
      "min-w-0",
      "flex-1"
    );
    expect(
      screen.getByText("open-inspect/a-repository-name-that-does-not-fit-on-a-narrow-phone")
    ).toHaveClass("truncate");
    expect(
      screen.getByRole("button", { name: "Toggle session details" }).parentElement
    ).toHaveClass("shrink-0");
  });

  it("shows the sandbox failure reason", () => {
    render(
      <SessionHeader
        sessionState={{
          id: "session-1",
          title: "Broken sandbox",
          repoOwner: "open-inspect",
          repoName: "background-agents",
          baseBranch: "main",
          branchName: "fix/sandbox",
          status: "active",
          sandboxStatus: "failed",
          messageCount: 0,
          createdAt: 1,
        }}
        sandboxError="Total disk limit exceeded"
        fallbackSessionInfo={{ repoOwner: null, repoName: null, title: null }}
        connected={true}
        connecting={false}
        participants={[]}
        isDetailsOpen={false}
        detailsButtonRef={createRef<HTMLButtonElement>()}
        onToggleDetails={vi.fn()}
        renameSession={vi.fn()}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Sandbox failed: Total disk limit exceeded"
    );
  });
});
