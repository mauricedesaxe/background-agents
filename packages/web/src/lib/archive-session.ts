import { browserApiFetch } from "@/lib/browser-api-fetch";

const ARCHIVE_CONCURRENCY = 4;

export type ArchiveSessionOutcome =
  | { kind: "archived"; sessionId: string }
  | { kind: "failed"; sessionId: string; reason: string };

export async function archiveSession(sessionId: string): Promise<ArchiveSessionOutcome> {
  try {
    const response = await browserApiFetch(`/api/sessions/${sessionId}/archive`, {
      method: "POST",
    });
    if (!response.ok) {
      const reason = await response
        .json()
        .then((body: { error?: unknown }) => (typeof body.error === "string" ? body.error : null))
        .catch(() => null);
      return { kind: "failed", sessionId, reason: reason ?? "Failed to archive session" };
    }

    return { kind: "archived", sessionId };
  } catch {
    return { kind: "failed", sessionId, reason: "Failed to archive session" };
  }
}

export async function archiveSessions(
  sessionIds: ReadonlySet<string>
): Promise<ArchiveSessionOutcome[]> {
  const ids = [...sessionIds];
  const outcomes: ArchiveSessionOutcome[] = new Array(ids.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: Math.min(ARCHIVE_CONCURRENCY, ids.length) }, async () => {
      while (nextIndex < ids.length) {
        const index = nextIndex++;
        const sessionId = ids[index];
        if (sessionId) outcomes[index] = await archiveSession(sessionId);
      }
    })
  );

  return outcomes;
}
