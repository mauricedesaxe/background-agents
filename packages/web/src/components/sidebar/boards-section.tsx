"use client";

import type { Artifact } from "@/types/session";
import type { OpenBoard } from "@/components/board-overlay";

interface BoardsSectionProps {
  boardArtifacts: Artifact[];
  onOpenBoard: (board: OpenBoard) => void;
}

/**
 * Lists the session's interactive whiteboards. Each opens the live tldraw board
 * (the board document lives in the BoardRoom DO, so it stays editable even when
 * the sandbox is asleep). A board artifact carries no bytes to preview — unlike
 * screenshots — so this renders launchers, not thumbnails.
 */
export function BoardsSection({ boardArtifacts, onOpenBoard }: BoardsSectionProps) {
  if (boardArtifacts.length === 0) return null;

  return (
    <div className="grid grid-cols-1 gap-2">
      {boardArtifacts.map((artifact) => {
        const boardId = artifact.metadata?.boardId;
        if (!boardId) return null;
        const title = artifact.metadata?.title || "Whiteboard";
        return (
          <button
            key={artifact.id}
            type="button"
            onClick={() => onOpenBoard({ boardId, title })}
            className="flex items-center justify-between rounded border border-border-muted bg-muted/40 px-3 py-2 text-left text-sm transition hover:border-accent hover:bg-muted"
          >
            <span className="truncate font-medium">{title}</span>
            <span className="ml-2 shrink-0 text-xs text-accent">Open</span>
          </button>
        );
      })}
    </div>
  );
}
