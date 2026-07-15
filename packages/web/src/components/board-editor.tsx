"use client";

import "tldraw/tldraw.css";
import { useCallback } from "react";
import { useSync } from "@tldraw/sync";
import { Tldraw, type TLAssetStore } from "tldraw";
import { WS_URL } from "@/lib/ws-url";

/**
 * Boards are shape-only: no embedded image/video bytes, so there is no R2 asset
 * path. `useSync` still requires an asset store, so provide one that refuses
 * uploads; `resolve` never runs because no asset is ever created.
 */
const boardAssets: TLAssetStore = {
  upload() {
    return Promise.reject(new Error("Image assets are not supported on boards"));
  },
  resolve: () => null,
};

// Optional: without a key, tldraw shows the free "Made with tldraw" watermark.
// Set on a real domain to remove it (requires a commercial license).
const LICENSE_KEY = process.env.NEXT_PUBLIC_TLDRAW_LICENSE_KEY;

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
 * No `assets` store is passed: boards are shape-only (no embedded images), so
 * there is no R2 asset path. The default `tldraw` shape/binding set matches the
 * server room schema (both pinned to one tldraw version).
 */
export default function BoardEditor({ sessionId, boardId }: BoardEditorProps) {
  const uri = useCallback(async () => {
    const res = await fetch(`/api/sessions/${sessionId}/ws-token`, { method: "POST" });
    if (!res.ok) {
      throw new Error("Failed to authenticate board connection");
    }
    const { token } = (await res.json()) as { token: string };
    return `${WS_URL}/sessions/${sessionId}/board/${boardId}/ws?token=${encodeURIComponent(token)}`;
  }, [sessionId, boardId]);

  const store = useSync({ uri, assets: boardAssets });

  return (
    <div className="absolute inset-0">
      <Tldraw store={store} licenseKey={LICENSE_KEY} />
    </div>
  );
}
