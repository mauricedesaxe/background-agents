import { describe, expect, it } from "vitest";
import { normalizeBoardTitle } from "./board";

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
