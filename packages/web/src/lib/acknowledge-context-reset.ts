import { toast } from "sonner";
import { browserApiFetch } from "@/lib/browser-api-fetch";

const GENERIC_ACKNOWLEDGE_FAILURE = "Failed to acknowledge context reset";

/**
 * Acknowledges a context reset so the session's held prompt dispatches on the
 * fresh context. Returns `true` when the hold was released; `false` includes
 * the nothing-held case (409), where a stale row was already released.
 */
export async function acknowledgeContextReset(sessionId: string): Promise<boolean> {
  try {
    const response = await browserApiFetch(`/api/sessions/${sessionId}/acknowledge-context-reset`, {
      method: "POST",
    });
    if (response.ok) return true;
    if (response.status !== 409) {
      toast.error(GENERIC_ACKNOWLEDGE_FAILURE);
    }
    return false;
  } catch {
    toast.error(GENERIC_ACKNOWLEDGE_FAILURE);
    return false;
  }
}
