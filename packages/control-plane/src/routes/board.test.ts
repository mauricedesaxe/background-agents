import { describe, expect, it } from "vitest";
import { buildBoardInspectionUrl, hasBoardArtifact, normalizeBoardTitle } from "./board";

describe("normalizeBoardTitle", () => {
  it("trims a normal title", () => {
    expect(normalizeBoardTitle("  System design  ")).toBe("System design");
  });

  it("falls back to the default for empty, whitespace, or non-string input", () => {
    expect(normalizeBoardTitle("")).toBe("Whiteboard");
    expect(normalizeBoardTitle("   ")).toBe("Whiteboard");
    expect(normalizeBoardTitle(undefined)).toBe("Whiteboard");
    expect(normalizeBoardTitle(42)).toBe("Whiteboard");
  });

  it("caps the title at 200 characters", () => {
    const long = "x".repeat(250);
    expect(normalizeBoardTitle(long)).toHaveLength(200);
  });
});

describe("board inspection", () => {
  it("only recognizes a board artifact with the requested board id", () => {
    const artifacts = [
      { type: "screenshot", metadata: { boardId: "board-1" } },
      { type: "board", metadata: { boardId: "board-2" } },
    ];

    expect(hasBoardArtifact(artifacts, "board-2")).toBe(true);
    expect(hasBoardArtifact(artifacts, "board-1")).toBe(false);
  });

  it("places the inspection token in the URL fragment", () => {
    expect(
      buildBoardInspectionUrl("https://app.example.com/", "session 1", "board/1", "secret token")
    ).toBe("https://app.example.com/board/inspect/session%201/board%2F1#token=secret%20token");
  });
});
