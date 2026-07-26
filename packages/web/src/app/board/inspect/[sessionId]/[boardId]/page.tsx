"use client";

import dynamic from "next/dynamic";
import { useParams } from "next/navigation";

const BoardInspection = dynamic(() => import("@/components/board-inspection"), { ssr: false });

export default function BoardInspectionPage() {
  const { sessionId, boardId } = useParams<{ sessionId: string; boardId: string }>();
  return <BoardInspection sessionId={sessionId} boardId={boardId} />;
}
