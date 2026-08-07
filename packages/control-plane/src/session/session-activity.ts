/**
 * Sandbox events that count as session activity for both the inactivity timer
 * and auto-archive. Excluded on purpose: token (high-frequency), tool_result
 * (no signal past tool_call), heartbeat (VM liveness), session_title (cosmetic).
 */
export const SESSION_ACTIVITY_SANDBOX_EVENT_TYPES: ReadonlySet<string> = new Set([
  "artifact",
  "tool_call",
  "step_start",
  "step_finish",
  "execution_complete",
  "git_sync",
  "push_complete",
  "push_error",
]);

export function isSessionActivitySandboxEvent(eventType: string): boolean {
  return SESSION_ACTIVITY_SANDBOX_EVENT_TYPES.has(eventType);
}
