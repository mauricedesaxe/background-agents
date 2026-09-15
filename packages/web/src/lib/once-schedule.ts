import type { SessionTargetRequestFields } from "@/lib/session-target";

/** A once automation as the POST /api/automations body. */
export interface OnceAutomationRequest {
  name: string;
  instructions: string;
  triggerType: "once";
  onceRunAt: number;
  repositories?: Array<{ repoOwner: string; repoName: string }>;
  environmentIds?: string[];
}

const MAX_DERIVED_NAME_LENGTH = 80;

export function deriveOnceAutomationName(instructions: string): string {
  const firstLine = instructions.trim().split("\n")[0]!.trim();
  if (!firstLine) return "Scheduled run";
  if (firstLine.length <= MAX_DERIVED_NAME_LENGTH) return firstLine;
  return `${firstLine.slice(0, MAX_DERIVED_NAME_LENGTH - 1)}…`;
}

/**
 * Validate the schedule-prompt popover form: a non-empty prompt and a future
 * fire-at time (epoch ms). Returns the error message, or null when valid.
 */
export function validateOnceScheduleForm(
  input: { instructions: string; onceRunAt: number | null },
  now: number
): string | null {
  if (!input.instructions.trim()) return "Enter a prompt to schedule.";
  if (input.onceRunAt === null || !Number.isFinite(input.onceRunAt)) {
    return "Choose when to run this.";
  }
  if (input.onceRunAt <= now) return "Choose a time in the future.";
  return null;
}

/** Build the create-automation request from the popover form state. */
export function buildOnceAutomationRequest(
  instructions: string,
  onceRunAt: number,
  target: SessionTargetRequestFields | null
): OnceAutomationRequest {
  const base: OnceAutomationRequest = {
    name: deriveOnceAutomationName(instructions),
    instructions: instructions.trim(),
    triggerType: "once",
    onceRunAt,
  };
  if (!target) return base;
  if ("environmentId" in target) {
    return { ...base, environmentIds: [target.environmentId] };
  }
  if ("repositories" in target) {
    return {
      ...base,
      repositories: target.repositories.map(({ repoOwner, repoName }) => ({
        repoOwner,
        repoName,
      })),
    };
  }
  if (target.repoOwner && target.repoName) {
    return { ...base, repositories: [{ repoOwner: target.repoOwner, repoName: target.repoName }] };
  }
  return base;
}
