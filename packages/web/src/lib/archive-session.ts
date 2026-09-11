import { toast } from "sonner";
import { browserApiFetch } from "@/lib/browser-api-fetch";

const GENERIC_ARCHIVE_FAILURE = "Failed to archive session";

/** The server's `error` field, when the failed response body carries one. */
async function readServerErrorMessage(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" && body.error.length > 0 ? body.error : null;
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
      toast.error((await readServerErrorMessage(response)) ?? GENERIC_ARCHIVE_FAILURE);
      return false;
    }

    return true;
  } catch {
    toast.error(GENERIC_ARCHIVE_FAILURE);
    return false;
  }
}
