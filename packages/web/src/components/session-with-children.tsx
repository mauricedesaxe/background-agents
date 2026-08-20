"use client";

import { useState } from "react";
import { SessionListItem, ChildSessionListItem } from "@/components/session-list-item";
import { ChevronRightIcon } from "@/components/ui/icons";
import type { SessionItem } from "@/hooks/use-sidebar-sessions";

export function SessionWithChildren({
  session,
  environmentName,
  childrenMap,
  currentSessionId,
  isMobile,
  onArchive,
  onSessionSelect,
  onMarkLatestMessageRead,
  onMarkUnread,
  selection,
}: {
  session: SessionItem;
  environmentName?: string;
  childrenMap: Map<string, SessionItem[]>;
  currentSessionId: string | null;
  isMobile: boolean;
  onArchive: (sessionId: string) => Promise<void>;
  onSessionSelect?: () => void;
  onMarkLatestMessageRead: (sessionId: string) => Promise<void>;
  onMarkUnread: (sessionId: string) => Promise<void>;
  selection?: { selected: boolean; onSelectedChange: (selected: boolean) => void };
}) {
  const childSessions = childrenMap.get(session.id) ?? [];
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <div className="relative">
        {childSessions.length > 0 && (
          <DisclosureToggle
            expanded={expanded}
            count={childSessions.length}
            depth={0}
            onToggle={() => setExpanded((value) => !value)}
          />
        )}
        <SessionListItem
          session={session}
          environmentName={environmentName}
          isActive={session.id === currentSessionId}
          isMobile={isMobile}
          onArchive={onArchive}
          onSessionSelect={onSessionSelect}
          onMarkLatestMessageRead={onMarkLatestMessageRead}
          onMarkUnread={onMarkUnread}
          selection={selection}
        />
      </div>
      {expanded && (
        <ChildSessionTree
          parentId={session.id}
          childrenMap={childrenMap}
          currentSessionId={currentSessionId}
          isMobile={isMobile}
          onSessionSelect={onSessionSelect}
          onMarkLatestMessageRead={onMarkLatestMessageRead}
          onMarkUnread={onMarkUnread}
          visitedIds={new Set([session.id])}
          depth={1}
        />
      )}
    </>
  );
}

function ChildSessionTree({
  parentId,
  childrenMap,
  currentSessionId,
  isMobile,
  onSessionSelect,
  onMarkLatestMessageRead,
  onMarkUnread,
  visitedIds,
  depth,
}: {
  parentId: string;
  childrenMap: Map<string, SessionItem[]>;
  currentSessionId: string | null;
  isMobile: boolean;
  onSessionSelect?: () => void;
  onMarkLatestMessageRead: (sessionId: string) => Promise<void>;
  onMarkUnread: (sessionId: string) => Promise<void>;
  visitedIds: Set<string>;
  depth: number;
}) {
  const childSessions = childrenMap.get(parentId);
  if (!childSessions?.length) return null;

  return childSessions.map((child) => {
    if (visitedIds.has(child.id)) return null;
    return (
      <CollapsibleChildSession
        key={child.id}
        child={child}
        childrenMap={childrenMap}
        currentSessionId={currentSessionId}
        isMobile={isMobile}
        onSessionSelect={onSessionSelect}
        onMarkLatestMessageRead={onMarkLatestMessageRead}
        onMarkUnread={onMarkUnread}
        visitedIds={visitedIds}
        depth={depth}
      />
    );
  });
}

function CollapsibleChildSession({
  child,
  childrenMap,
  currentSessionId,
  isMobile,
  onSessionSelect,
  onMarkLatestMessageRead,
  onMarkUnread,
  visitedIds,
  depth,
}: {
  child: SessionItem;
  childrenMap: Map<string, SessionItem[]>;
  currentSessionId: string | null;
  isMobile: boolean;
  onSessionSelect?: () => void;
  onMarkLatestMessageRead: (sessionId: string) => Promise<void>;
  onMarkUnread: (sessionId: string) => Promise<void>;
  visitedIds: Set<string>;
  depth: number;
}) {
  const grandchildren = childrenMap.get(child.id) ?? [];
  const [expanded, setExpanded] = useState(false);
  const nextVisitedIds = new Set(visitedIds);
  nextVisitedIds.add(child.id);

  return (
    <>
      <div className="relative">
        {grandchildren.length > 0 && (
          <DisclosureToggle
            expanded={expanded}
            count={grandchildren.length}
            depth={depth}
            onToggle={() => setExpanded((value) => !value)}
          />
        )}
        <ChildSessionListItem
          session={child}
          isActive={child.id === currentSessionId}
          isMobile={isMobile}
          onSessionSelect={onSessionSelect}
          onMarkLatestMessageRead={onMarkLatestMessageRead}
          onMarkUnread={onMarkUnread}
          depth={depth}
        />
      </div>
      {expanded && (
        <ChildSessionTree
          parentId={child.id}
          childrenMap={childrenMap}
          currentSessionId={currentSessionId}
          isMobile={isMobile}
          onSessionSelect={onSessionSelect}
          onMarkLatestMessageRead={onMarkLatestMessageRead}
          onMarkUnread={onMarkUnread}
          visitedIds={nextVisitedIds}
          depth={depth + 1}
        />
      )}
    </>
  );
}

function DisclosureToggle({
  expanded,
  count,
  depth,
  onToggle,
}: {
  expanded: boolean;
  count: number;
  depth: number;
  onToggle: () => void;
}) {
  const leftRem = depth === 0 ? 0.15 : 1.75 + Math.max(depth - 1, 0) * 1 - 1;
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={`${expanded ? "Collapse" : "Expand"} ${count} sub-task${count === 1 ? "" : "s"}`}
      onClick={onToggle}
      style={{ left: `${leftRem}rem` }}
      className="absolute top-2 z-10 flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition hover:bg-muted hover:text-foreground"
    >
      <ChevronRightIcon
        className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-90" : ""}`}
      />
    </button>
  );
}
