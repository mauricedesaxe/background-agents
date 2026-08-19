/**
 * BetterStack webhook route — per-automation endpoint. BetterStack does not sign
 * its webhooks, so the request is authenticated with a shared secret the user
 * configures as a custom header, compared to the automation's stored secret.
 */

import {
  verifyBetterstackSecret,
  normalizeBetterstackEvent,
  BETTERSTACK_SECRET_HEADER,
} from "@open-inspect/shared/triggers";
import { AutomationStore } from "../db/automation-store";
import { decryptSentrySecret } from "../auth/webhook-key";
import { createLogger } from "../logger";
import type { Route, RequestContext } from "../routes/shared";
import {
  defineRoute,
  error,
  json,
  parsePattern,
  SCM_AGNOSTIC_HANDLER_AUTHENTICATED_ROUTE,
} from "../routes/shared";
import type { Env } from "../types";

/** Maximum BetterStack webhook payload size. */
const MAX_PAYLOAD_SIZE = 256 * 1024;
const logger = createLogger("betterstack-webhook");

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function handleBetterstackWebhook(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const automationId = match.groups?.id;
  if (!automationId) return error("Automation ID required", 400);

  const store = new AutomationStore(ctx.db);
  const automation = await store.getById(automationId);
  if (!automation || automation.trigger_type !== "betterstack") {
    return error("Not found", 404);
  }

  if (!automation.trigger_auth_data) {
    return error("BetterStack secret not configured for this automation", 500);
  }

  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    return error("Encryption key not configured", 503);
  }

  const presentedSecret = request.headers.get(BETTERSTACK_SECRET_HEADER);
  if (!presentedSecret) {
    return error("Invalid secret", 401); // reject before any expensive work (decrypt, body read)
  }

  const contentLength = parseInt(request.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_PAYLOAD_SIZE) {
    return error("Payload too large", 413);
  }

  const secret = await decryptSentrySecret(
    automation.trigger_auth_data,
    env.REPO_SECRETS_ENCRYPTION_KEY
  );
  if (!verifyBetterstackSecret(presentedSecret, secret)) {
    return error("Invalid secret", 401);
  }

  const body = await request.text();
  if (body.length > MAX_PAYLOAD_SIZE) {
    return error("Payload too large", 413);
  }

  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(body) as unknown;
  } catch {
    return error("Invalid JSON", 400);
  }
  const payload = isRecord(parsedPayload) ? parsedPayload : {};

  const normalization = normalizeBetterstackEvent(payload, automationId);
  if (normalization.status === "skipped") {
    logger.info("BetterStack webhook skipped during normalization", {
      event: "betterstack.webhook_skipped",
      reason: normalization.reason,
      automation_id: automationId,
      configured_event_type: automation.event_type,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return json({ ok: true, skipped: true });
  }
  const event = normalization.event;

  if (!env.SCHEDULER) {
    return error("Scheduler not configured", 503);
  }

  const doId = env.SCHEDULER.idFromName("global-scheduler");
  const stub = env.SCHEDULER.get(doId);

  const response = await stub.fetch("http://internal/internal/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });

  const result = await response.json<{ triggered: number; skipped: number }>();
  return json({ ok: true, ...result }, response.status === 200 ? 200 : response.status);
}

export const betterstackWebhookRoute: Route = defineRoute(
  SCM_AGNOSTIC_HANDLER_AUTHENTICATED_ROUTE,
  {
    method: "POST",
    pattern: parsePattern("/webhooks/betterstack/:id"),
    handler: handleBetterstackWebhook,
  }
);
