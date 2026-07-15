"use client";

import dynamic from "next/dynamic";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

// tldraw is heavy and browser-only; never render it on the server.
const BoardEditor = dynamic(() => import("./board-editor"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      Loading whiteboard…
    </div>
  ),
});

export interface OpenBoard {
  boardId: string;
  title: string;
}

interface BoardOverlayProps {
  sessionId: string;
  board: OpenBoard | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BoardOverlay({ sessionId, board, open, onOpenChange }: BoardOverlayProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Override DialogContent's default `grid` with a flex column: tldraw needs
          the editor container to actually fill the remaining height, and `flex-1`
          only works in a flex parent. Without this the canvas collapses to 0px. */}
      <DialogContent className="flex h-[92vh] w-[96vw] max-w-[1400px] flex-col gap-0 border-border-muted bg-background p-0">
        <DialogTitle className="shrink-0 px-4 py-3 text-sm">
          {board?.title ?? "Whiteboard"}
        </DialogTitle>
        <DialogDescription className="sr-only">
          Interactive tldraw whiteboard. Edit live; the agent can pick up your changes.
        </DialogDescription>
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {open && board && <BoardEditor sessionId={sessionId} boardId={board.boardId} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
