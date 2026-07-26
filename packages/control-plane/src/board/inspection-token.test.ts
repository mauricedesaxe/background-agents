import { describe, expect, it } from "vitest";
import { mintBoardInspectionToken, verifyBoardInspectionToken } from "./inspection-token";
import { epochMs } from "../time";

const SECRET = "inspection-test-secret";

describe("board inspection tokens", () => {
  it("verifies the session and board the token was minted for", async () => {
    const token = await mintBoardInspectionToken(
      { sessionId: "session-1", boardId: "board-1", expiresAtMs: epochMs(2_000) },
      SECRET
    );

    await expect(
      verifyBoardInspectionToken(token, SECRET, {
        sessionId: "session-1",
        boardId: "board-1",
        nowMs: epochMs(1_000),
      })
    ).resolves.toEqual({ ok: true });
  });

  it("rejects expired tokens", async () => {
    const token = await mintBoardInspectionToken(
      { sessionId: "session-1", boardId: "board-1", expiresAtMs: epochMs(2_000) },
      SECRET
    );

    await expect(
      verifyBoardInspectionToken(token, SECRET, {
        sessionId: "session-1",
        boardId: "board-1",
        nowMs: epochMs(2_001),
      })
    ).resolves.toEqual({ ok: false, error: "expired" });
  });

  it.each([
    ["session-2", "board-1"],
    ["session-1", "board-2"],
  ])("rejects a token used for session %s and board %s", async (sessionId, boardId) => {
    const token = await mintBoardInspectionToken(
      { sessionId: "session-1", boardId: "board-1", expiresAtMs: epochMs(2_000) },
      SECRET
    );

    await expect(
      verifyBoardInspectionToken(token, SECRET, {
        sessionId,
        boardId,
        nowMs: epochMs(1_000),
      })
    ).resolves.toEqual({ ok: false, error: "scope_mismatch" });
  });

  it("rejects a token whose signature was changed", async () => {
    const token = await mintBoardInspectionToken(
      { sessionId: "session-1", boardId: "board-1", expiresAtMs: epochMs(2_000) },
      SECRET
    );
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;

    await expect(
      verifyBoardInspectionToken(tampered, SECRET, {
        sessionId: "session-1",
        boardId: "board-1",
        nowMs: epochMs(1_000),
      })
    ).resolves.toEqual({ ok: false, error: "invalid" });
  });
});
