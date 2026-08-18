"use client";

import { useCallback } from "react";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { WS_URL } from "@/lib/ws-url";
import { BoardCanvas, useBoardSync } from "./board-canvas";

export interface BoardEditorProps {
  sessionId: string;
  boardId: string;
}

/**
 * The live tldraw editor for one board. Connects to the BoardRoom sync room as a
 * browser peer over the board WebSocket. Client-only (tldraw touches browser
 * APIs at import): load it via `next/dynamic` with `ssr: false`.
 *
 * The room URL is minted per (re)connection: `useSync` calls this async `uri`
 * each time it opens the socket, so we fetch a fresh session ws-token (the same
 * cookie-authed endpoint the session socket uses) and pass it in the query — a
 * raw WebSocket can't send an Authorization header. `useSync` appends its own
 * `sessionId` param via URLSearchParams, so the `?token=` here is preserved.
 *
 * Boards are shape-only, so the shared board asset store rejects uploads. The
 * default `tldraw` shape/binding set matches the server room schema.
 */
export default function BoardEditor({ sessionId, boardId }: BoardEditorProps) {
  const uri = useCallback(async () => {
    const res = await browserApiFetch(`/api/sessions/${sessionId}/ws-token`, { method: "POST" });
    if (!res.ok) {
      throw new Error("Failed to authenticate board connection");
    }
    const { token } = (await res.json()) as { token: string };
    return `${WS_URL}/sessions/${sessionId}/board/${boardId}/ws?token=${encodeURIComponent(token)}`;
  }, [sessionId, boardId]);

  const store = useBoardSync(uri);

  return (
    <div className="absolute inset-0">
      <BoardCanvas store={store} />
    </div>
  );
}
