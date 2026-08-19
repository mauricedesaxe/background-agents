/**
 * BetterStack trigger source module.
 */

import type { TriggerSourceDefinition } from "../types";

export type { BetterstackIncidentPayload } from "./payloads";
export { normalizeBetterstackEvent } from "./normalizer";
export { buildBetterstackContextBlock } from "./context";
export { verifyBetterstackSecret, BETTERSTACK_SECRET_HEADER } from "./signature";

export const betterstackSource: TriggerSourceDefinition = {
  source: "betterstack",
  triggerType: "betterstack",
  displayName: "BetterStack",
  description: "Trigger when BetterStack reports a new incident",
  supportsEventTypes: true,
  eventTypePlaceholder: "Select BetterStack event type...",
  eventTypes: [
    {
      eventType: "incident.started",
      displayName: "Incident started",
      description: "A new BetterStack incident has started",
    },
  ],
  supportedConditions: [],
};
