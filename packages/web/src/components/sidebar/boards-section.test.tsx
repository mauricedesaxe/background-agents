// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Artifact } from "@/types/session";
import { BoardsSection } from "./boards-section";

afterEach(() => cleanup());

function boardArtifact(id: string, boardId: string | undefined, title?: string): Artifact {
  return {
    id,
    type: "board",
    url: null,
    metadata: boardId ? { boardId, title } : {},
    createdAt: 1,
  };
}

describe("BoardsSection", () => {
  it("renders nothing when there are no boards", () => {
    const { container } = render(<BoardsSection boardArtifacts={[]} onOpenBoard={vi.fn()} />);
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders the board title and opens it on click", async () => {
    const onOpenBoard = vi.fn();
    const { container } = render(
      <BoardsSection
        boardArtifacts={[boardArtifact("a1", "board-1", "System design")]}
        onOpenBoard={onOpenBoard}
      />
    );

    const button = container.querySelector("button");
    expect(button?.textContent).toContain("System design");
    await userEvent.click(button!);
    expect(onOpenBoard).toHaveBeenCalledWith({ boardId: "board-1", title: "System design" });
  });

  it("falls back to a default title when none is set", () => {
    const { container } = render(
      <BoardsSection boardArtifacts={[boardArtifact("a1", "board-1")]} onOpenBoard={vi.fn()} />
    );
    expect(container.querySelector("button")?.textContent).toContain("Whiteboard");
  });

  it("skips a board artifact with no boardId in metadata", () => {
    const { container } = render(
      <BoardsSection boardArtifacts={[boardArtifact("a1", undefined)]} onOpenBoard={vi.fn()} />
    );
    expect(container.querySelector("button")).toBeNull();
  });
});
