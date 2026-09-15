/**
 * Web-only persistence for the "mark as unread" action.
 *
 * The server read-state API only supports marking messages read — there is no
 * `mark_unread` write, and the fork's old `manually_unread` D1 column is not
 * restored (the fork's 9005 migration collides conceptually with upstream's
 * `session_read_states`). The flag therefore lives in localStorage, keyed per
 * user, and `useSidebarSessions` overlays it onto the server read state at
 * render. It survives reloads but is invisible to the server: a manually
 * unread session stays in its section and other clients do not see it.
 */
const MANUAL_UNREAD_STORAGE_KEY_PREFIX = "open-inspect-session-manual-unread:";

function storageKey(userId: string): string {
  return `${MANUAL_UNREAD_STORAGE_KEY_PREFIX}${userId}`;
}

export function readManualUnreadIds(userId: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey(userId)) ?? "[]");
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

/** Writes the flag and returns the resulting id set for state updates. */
export function writeManualUnreadId(
  userId: string,
  sessionId: string,
  unread: boolean
): Set<string> {
  const ids = readManualUnreadIds(userId);
  if (unread) {
    ids.add(sessionId);
  } else {
    ids.delete(sessionId);
  }
  persist(userId, [...ids]);
  return ids;
}

function persist(userId: string, ids: string[]): void {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(ids));
  } catch {
    return;
  }
}
