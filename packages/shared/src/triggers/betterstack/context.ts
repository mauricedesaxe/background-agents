/**
 * Build context blocks for BetterStack automation events.
 */

import type { BetterstackIncidentPayload } from "./payloads";

export function buildBetterstackContextBlock(payload: BetterstackIncidentPayload): string {
  const { id, attributes } = payload.data;
  const lines: string[] = [
    "This automation was triggered by a new BetterStack incident.",
    "",
    `Incident: ${attributes.name ?? id}`,
  ];

  if (attributes.cause) lines.push(`Cause: ${attributes.cause}`);
  if (attributes.status) lines.push(`Status: ${attributes.status}`);
  if (attributes.started_at) lines.push(`Started: ${attributes.started_at}`);
  if (attributes.url) lines.push(`URL: ${attributes.url}`);

  return lines.join("\n");
}
