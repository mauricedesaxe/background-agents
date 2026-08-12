/** @vitest-environment jsdom */
import { useEffect } from "react";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const syncState = vi.hoisted(() => ({
  value: { status: "synced-remote", store: {} } as
    | { status: "synced-remote"; store: object }
    | { status: "loading" }
    | { status: "error"; error: Error },
}));

const editor = vi.hoisted(() => ({
  updateInstanceState: vi.fn(),
  selectNone: vi.fn(),
  fonts: {
    getShapeFontFaces: vi.fn<() => { family: string }[]>(() => []),
    loadRequiredFontsForCurrentPage: vi.fn<() => Promise<void>>(async () => undefined),
  },
  zoomToFit: vi.fn(),
  getCurrentPageShapes: vi.fn<() => { id: string }[]>(() => []),
}));

vi.mock("./board-canvas", () => ({
  useBoardSync: () => syncState.value,
  BoardCanvas: ({ onMount }: { onMount?: (value: typeof editor) => void }) => {
    useEffect(() => onMount?.(editor), [onMount]);
    return <div data-testid="canvas" />;
  },
}));

vi.mock("@/lib/ws-url", () => ({ WS_URL: "wss://worker.test" }));

import BoardInspection from "./board-inspection";

describe("BoardInspection", () => {
  beforeEach(() => {
    syncState.value = { status: "synced-remote", store: {} };
    editor.getCurrentPageShapes.mockReturnValue([]);
    window.location.hash = "#token=inspection-token";
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready: Promise.resolve(), check: vi.fn(() => true) },
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  it("declares a synced empty board ready only after preparing the renderer", async () => {
    const view = render(<BoardInspection sessionId="session-1" boardId="board-1" />);

    await waitFor(() =>
      expect(view.container.querySelector('[data-board-inspection-state="ready"]')).not.toBeNull()
    );
    const marker = view.container.querySelector('[data-board-inspection-state="ready"]');
    expect(marker?.getAttribute("data-board-inspection-empty")).toBe("true");
    expect(editor.updateInstanceState).toHaveBeenCalledWith({ isReadonly: true });
    expect(editor.fonts.loadRequiredFontsForCurrentPage).toHaveBeenCalled();
    expect(editor.zoomToFit).toHaveBeenCalled();
  });

  it("exposes a machine-readable sync error instead of an empty canvas", async () => {
    syncState.value = { status: "error", error: new Error("socket rejected") };
    const view = render(<BoardInspection sessionId="session-1" boardId="board-1" />);

    await waitFor(() =>
      expect(view.container.querySelector('[data-board-inspection-state="error"]')).not.toBeNull()
    );
    const marker = view.container.querySelector('[data-board-inspection-state="error"]');
    expect(marker?.getAttribute("data-board-inspection-error")).toBe("socket rejected");
  });

  it("does not let delayed renderer preparation overwrite a sync error", async () => {
    let finishFontLoad!: () => void;
    editor.fonts.loadRequiredFontsForCurrentPage.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishFontLoad = resolve;
      })
    );
    const view = render(<BoardInspection sessionId="session-1" boardId="board-1" />);

    await waitFor(() => expect(editor.fonts.loadRequiredFontsForCurrentPage).toHaveBeenCalled());
    syncState.value = { status: "error", error: new Error("connection lost") };
    view.rerender(<BoardInspection sessionId="session-1" boardId="board-1" />);
    finishFontLoad();

    await waitFor(() =>
      expect(
        view.container
          .querySelector('[data-board-inspection-state="error"]')
          ?.getAttribute("data-board-inspection-error")
      ).toBe("connection lost")
    );
    expect(view.container.querySelector('[data-board-inspection-state="ready"]')).toBeNull();
  });

  it("reports a required font failure instead of declaring readiness", async () => {
    editor.getCurrentPageShapes.mockReturnValueOnce([{ id: "shape:text" }]);
    editor.fonts.getShapeFontFaces.mockReturnValueOnce([{ family: "Missing Font" }]);
    vi.mocked(document.fonts.check).mockReturnValueOnce(false);
    const view = render(<BoardInspection sessionId="session-1" boardId="board-1" />);

    await waitFor(() =>
      expect(
        view.container
          .querySelector('[data-board-inspection-state="error"]')
          ?.getAttribute("data-board-inspection-error")
      ).toBe("Board font failed to load: Missing Font")
    );
    expect(view.container.querySelector('[data-board-inspection-state="ready"]')).toBeNull();
  });

  it("withdraws readiness while the board reconnects", async () => {
    const view = render(<BoardInspection sessionId="session-1" boardId="board-1" />);
    await waitFor(() =>
      expect(view.container.querySelector('[data-board-inspection-state="ready"]')).not.toBeNull()
    );

    syncState.value = { status: "loading" };
    view.rerender(<BoardInspection sessionId="session-1" boardId="board-1" />);

    expect(view.container.querySelector('[data-board-inspection-state="ready"]')).toBeNull();
    expect(view.getByLabelText("Loading board inspection")).toBeDefined();
  });
});
