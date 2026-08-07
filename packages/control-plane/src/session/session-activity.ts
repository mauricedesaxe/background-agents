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

export const EXCLUDED_FROM_ACTIVITY: ReadonlyArray<{ type: string; reason: string }> = [
  { type: "token", reason: "too high-frequency; isProcessing covers the long-running case" },
  { type: "tool_result", reason: "no independent signal past tool_call" },
  { type: "heartbeat", reason: "VM liveness, not session activity" },
  { type: "session_title", reason: "cosmetic" },
];

export function isSessionActivitySandboxEvent(eventType: string): boolean {
  return SESSION_ACTIVITY_SANDBOX_EVENT_TYPES.has(eventType);
}
