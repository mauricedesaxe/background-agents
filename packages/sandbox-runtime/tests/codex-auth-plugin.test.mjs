import assert from "node:assert/strict";
import test from "node:test";

import { rewriteProviderFailure } from "../src/sandbox_runtime/plugins/codex-auth-plugin.js";

/**
 * Captured from a real rejection on 2026-08-06, sandbox 9366023d, session
 * b0e49d71d674c8ef7474086a5afe8311. Inventing this shape would only test what we assumed the
 * provider sends.
 */
const USAGE_LIMIT_BODY = JSON.stringify({
  error: {
    type: "usage_limit_reached",
    message: "The usage limit has been reached",
    plan_type: "pro",
    resets_at: 1786163768,
    eligible_promo: null,
    resets_in_seconds: 165243,
  },
});

const CAPTURED_AT_MS = 1786001528000;

function usageLimitResponse(body = USAGE_LIMIT_BODY) {
  return new Response(body, { status: 429 });
}

async function messageFrom(response, now = CAPTURED_AT_MS) {
  const rewritten = await rewriteProviderFailure(response, now);
  return (await rewritten.json()).error.message;
}

test("names the plan and the reset time when the account is out of usage", async () => {
  const message = await messageFrom(usageLimitResponse());

  assert.match(message, /Out of model usage on your pro plan/);
  assert.match(message, /resets at 2026-08-08T04:36:08Z/);
  assert.match(message, /in 45h 4m/);
  assert.match(message, /Switch models or wait for the reset/);
});

test("still says something useful when the limit response carries no reset time", async () => {
  const body = JSON.stringify({ error: { type: "usage_limit_reached" } });

  assert.equal(
    await messageFrom(usageLimitResponse(body)),
    "Out of model usage on your current plan. Switch models or wait for the reset."
  );
});

test("rewrites the limit into a status the SDK reports instead of retrying", async () => {
  const rewritten = await rewriteProviderFailure(usageLimitResponse(), CAPTURED_AT_MS);

  assert.equal(rewritten.status, 400);
  assert.equal(rewritten.headers.get("content-type"), "application/json");
  assert.equal((await rewritten.json()).error.type, "open_inspect_provider_error");
});

test("leaves an ordinary rate-limit 429 retryable", async () => {
  const body = JSON.stringify({ error: { type: "rate_limit_exceeded", message: "slow down" } });
  const response = new Response(body, { status: 429 });

  const result = await rewriteProviderFailure(response, CAPTURED_AT_MS);

  assert.equal(result, response);
  assert.equal(result.status, 429);
});

test("leaves a rejection it cannot parse retryable", async () => {
  const response = new Response("<html>429 Too Many Requests</html>", { status: 429 });

  assert.equal(await rewriteProviderFailure(response, CAPTURED_AT_MS), response);
});

test("leaves the original response body readable after rewriting it", async () => {
  const original = usageLimitResponse();
  await rewriteProviderFailure(original, CAPTURED_AT_MS);

  assert.equal(await original.text(), USAGE_LIMIT_BODY);
});
