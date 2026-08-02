/**
 * Key selection for CP→bot callback body signatures.
 *
 * Callbacks are signed with the DESTINATION bot's per-service secret — the
 * CP legitimately holds every bot's verification key, and the bot verifies
 * with its own.
 */

import { serviceAuthSecret, type ServiceKeyEnv } from "./authenticate";
import type { Principal } from "./principal";

const CALLBACK_SOURCES = {
  "slack-bot": "slack",
  "linear-bot": "linear",
} as const;

export type CallbackDestination = keyof typeof CALLBACK_SOURCES;

/** The bots the CP delivers callbacks to — also the only services that may attach a `callbackContext`. */
export const CALLBACK_DESTINATIONS = Object.keys(CALLBACK_SOURCES) as CallbackDestination[];

export type CallbackSigningEnv = ServiceKeyEnv;

export function callbackSourceForPrincipal(
  principal: Principal | undefined
): "slack" | "linear" | null {
  if (principal?.kind !== "service" || !(principal.service in CALLBACK_SOURCES)) return null;
  return CALLBACK_SOURCES[principal.service as CallbackDestination];
}

export function callbackSigningSecret(
  env: CallbackSigningEnv,
  destination: CallbackDestination
): string | undefined {
  return serviceAuthSecret(env, destination);
}
