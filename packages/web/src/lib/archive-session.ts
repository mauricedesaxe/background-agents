import { toast } from "sonner";
import { browserApiFetch } from "@/lib/browser-api-fetch";

const GENERIC_ARCHIVE_FAILURE = "Failed to archive session";

/**
 * Fragments of the lifecycle errors the server answers with, which are safe
 * to show verbatim: not found, not promptable, forbidden. Anything else —
 * especially a 5xx body — is server internals and falls back to the generic
 * message.
 */
const SAFE_SERVER_ERROR_FRAGMENTS: readonly string[] = ["not found", "not promptable", "forbidden"];

/** The server's `error` field, when it carries one a user may read. */
async function readSafeServerErrorMessage(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error !== "string" || body.error.length === 0) return null;
    const normalized = body.error.toLowerCase();
    return SAFE_SERVER_ERROR_FRAGMENTS.some((fragment) => normalized.includes(fragment))
      ? body.error
      : null;
  } catch {
    return null;
  }
}

/**
 * Archives a session via the API.
 *
 * Returns `true` when the request succeeds. Callers are responsible for
 * updating any client-side caches or navigation state.
 */
export async function archiveSession(sessionId: string): Promise<boolean> {
  try {
    const response = await browserApiFetch(`/api/sessions/${sessionId}/archive`, {
      method: "POST",
    });
    if (!response.ok) {
      toast.error((await readSafeServerErrorMessage(response)) ?? GENERIC_ARCHIVE_FAILURE);
      return false;
    }

    return true;
  } catch {
    toast.error(GENERIC_ARCHIVE_FAILURE);
    return false;
  }
}
