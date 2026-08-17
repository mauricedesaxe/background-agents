"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "tldraw";
import { WS_URL } from "@/lib/ws-url";
import { BoardCanvas, useBoardSync } from "./board-canvas";

const INSPECTION_TIMEOUT_MS = 25_000;

type InspectionResult =
  | { state: "loading" }
  | { state: "ready"; empty: boolean }
  | { state: "error"; error: string };

export default function BoardInspection({
  sessionId,
  boardId,
}: {
  sessionId: string;
  boardId: string;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const value = fragment.get("token");
    if (!value) setTokenError("Inspection token missing");
    else setToken(value);
  }, []);

  if (tokenError) return <InspectionError message={tokenError} />;
  if (!token) return <InspectionLoading />;
  return <SyncedBoardInspection sessionId={sessionId} boardId={boardId} token={token} />;
}

function SyncedBoardInspection({
  sessionId,
  boardId,
  token,
}: {
  sessionId: string;
  boardId: string;
  token: string;
}) {
  const [result, setResult] = useState<InspectionResult>({ state: "loading" });
  const preparationVersion = useRef(0);
  const uri = useCallback(
    async () =>
      `${WS_URL}/sessions/${encodeURIComponent(sessionId)}/board/${encodeURIComponent(boardId)}/ws?token=${encodeURIComponent(token)}`,
    [sessionId, boardId, token]
  );
  const store = useBoardSync(uri, true);
  const syncError = store.status === "error" ? store.error.message || "Board sync failed" : null;

  useEffect(() => {
    if (result.state !== "loading") return;
    const timeout = window.setTimeout(
      () => setResult({ state: "error", error: "Board render timed out" }),
      INSPECTION_TIMEOUT_MS
    );
    return () => window.clearTimeout(timeout);
  }, [result.state]);

  useEffect(() => {
    if (store.status !== "synced-remote") {
      preparationVersion.current += 1;
      setResult((current) => (current.state === "error" ? current : { state: "loading" }));
    }
    if (syncError) {
      setResult({ state: "error", error: syncError });
    }
  }, [store.status, syncError]);

  const onMount = useCallback((editor: Editor) => {
    const version = preparationVersion.current;
    void prepareInspection(editor)
      .then((shapeCount) => {
        if (preparationVersion.current !== version) return;
        setResult((current) =>
          current.state === "loading" ? { state: "ready", empty: shapeCount === 0 } : current
        );
      })
      .catch((error) =>
        setResult((current) =>
          current.state === "loading"
            ? {
                state: "error",
                error: error instanceof Error ? error.message : "Board render failed",
              }
            : current
        )
      );
  }, []);

  const onRenderError = useCallback((error: unknown) => {
    preparationVersion.current += 1;
    setResult({
      state: "error",
      error: error instanceof Error ? error.message : "Board render failed",
    });
  }, []);

  if (result.state === "error") return <InspectionError message={result.error} />;

  return (
    <div className="h-screen w-screen overflow-hidden bg-white">
      {store.status === "synced-remote" ? (
        <BoardCanvas store={store.store} readonly onMount={onMount} onError={onRenderError} />
      ) : (
        <InspectionLoading />
      )}
      {store.status === "synced-remote" && result.state === "ready" ? (
        <div
          data-board-inspection-state="ready"
          data-board-inspection-empty={String(result.empty)}
          aria-hidden="true"
          className="fixed left-0 top-0 h-px w-px overflow-hidden"
        />
      ) : null}
    </div>
  );
}

async function prepareInspection(editor: Editor): Promise<number> {
  editor.updateInstanceState({ isReadonly: true });
  editor.selectNone();
  const requiredFonts = new Set(
    editor.getCurrentPageShapes().flatMap((shape) => editor.fonts.getShapeFontFaces(shape))
  );
  await editor.fonts.loadRequiredFontsForCurrentPage();
  await document.fonts.ready;
  for (const font of requiredFonts) {
    const descriptor = `${font.style ?? "normal"} ${font.weight ?? "normal"} 12px ${JSON.stringify(font.family)}`;
    if (!document.fonts.check(descriptor)) {
      throw new Error(`Board font failed to load: ${font.family}`);
    }
  }
  editor.zoomToFit({ animation: { duration: 0 } });
  await nextPaint();
  await nextPaint();
  return editor.getCurrentPageShapes().length;
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function InspectionLoading() {
  return <div className="h-screen w-screen bg-white" aria-label="Loading board inspection" />;
}

function InspectionError({ message }: { message: string }) {
  return (
    <div
      data-board-inspection-state="error"
      data-board-inspection-error={message}
      className="flex h-screen w-screen items-center justify-center bg-white p-8 font-mono text-sm text-red-700"
    >
      {message}
    </div>
  );
}
