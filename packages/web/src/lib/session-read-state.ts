export type SessionReadAction = "viewed" | "mark_read" | "mark_unread";

export async function updateSessionReadState(
  sessionId: string,
  action: SessionReadAction
): Promise<boolean> {
  const response = await fetch(`/api/sessions/${sessionId}/read-state`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  if (!response.ok) {
    throw new Error(`Failed to update session read state: ${response.status}`);
  }

  const body = (await response.json()) as { unread: boolean };
  return body.unread;
}
