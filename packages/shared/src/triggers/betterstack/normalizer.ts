import type { BetterstackAutomationEvent } from "../types";
import { buildBetterstackContextBlock } from "./context";
import { betterstackIncidentSchema } from "./payloads";

export type BetterstackNormalizationResult =
  | { status: "normalized"; event: BetterstackAutomationEvent }
  | { status: "skipped"; reason: "unsupported_action" | "invalid_shape" };

export function normalizeBetterstackEvent(
  payload: Record<string, unknown>,
  automationId?: string
): BetterstackNormalizationResult {
  const result = betterstackIncidentSchema.safeParse(payload);
  if (!result.success) {
    return { status: "skipped", reason: "invalid_shape" };
  }

  const { id, attributes } = result.data.data;

  if (attributes.acknowledged_at || attributes.resolved_at) {
    return { status: "skipped", reason: "unsupported_action" }; // only the initial "started" call fires
  }

  return {
    status: "normalized",
    event: {
      source: "betterstack",
      automationId: automationId ?? "",
      eventType: "incident.started",
      triggerKey: `betterstack_incident:${id}`,
      concurrencyKey: `betterstack_incident:${id}`,
      contextBlock: buildBetterstackContextBlock(result.data),
      meta: {
        incidentId: id,
        incidentUrl: attributes.url ?? undefined,
      },
    },
  };
}
