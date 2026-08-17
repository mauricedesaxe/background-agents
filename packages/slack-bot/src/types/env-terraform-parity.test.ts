import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A missing Worker binding is invisible to every other check we run. TypeScript
 * believes the `Env` interface, tests inject their own env, and a Terraform plan
 * cannot diff a binding that was never declared, so the first sign is a runtime
 * `undefined.send` in production. `SLACK_COMPLETION_QUEUE` shipped that way.
 *
 * The two files below are the only places that state what the worker needs and
 * what it gets, so comparing them is the one check that can catch the next one.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const ENV_TYPES = resolve(REPO_ROOT, "packages/slack-bot/src/types/index.ts");
const SLACK_WORKER_TF = resolve(REPO_ROOT, "terraform/environments/production/workers-slack.tf");

/** Binding names the `Env` interface declares as required (no `?`). */
function requiredEnvBindings(source: string): string[] {
  const body = source.match(/export interface Env \{([\s\S]*?)\n\}/);
  if (!body) throw new Error("Could not locate the Env interface in types/index.ts");
  const names: string[] = [];
  for (const line of body[1].split("\n")) {
    // Binding names are SCREAMING_SNAKE by convention; `?:` means optional.
    const member = line.match(/^\s{2}([A-Z][A-Z0-9_]*)(\??):/);
    if (member && member[2] !== "?") names.push(member[1]);
  }
  return names;
}

/**
 * Binding names the Slack worker's Terraform declares, across every binding
 * kind: `binding_name` for KV/service/queue, `name` for plain text and secrets.
 */
function declaredTerraformBindings(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/binding_name\s*=\s*"([^"]+)"/g)) names.add(m[1]);
  for (const m of source.matchAll(/\bname\s*=\s*"([A-Z][A-Z0-9_]*)"/g)) names.add(m[1]);
  return [...names];
}

describe("slack-bot Worker bindings", () => {
  it("declares every required Env binding in the production Terraform", () => {
    const required = requiredEnvBindings(readFileSync(ENV_TYPES, "utf8"));
    const declared = declaredTerraformBindings(readFileSync(SLACK_WORKER_TF, "utf8"));

    expect(required.length).toBeGreaterThan(0);
    expect(required.filter((name) => !declared.includes(name))).toEqual([]);
  });

  it("binds the completion queue the callback routes enqueue to", () => {
    // Pinned by name because this is the binding whose absence broke production:
    // the parity check above only compares sets, so it would pass if a future
    // edit dropped the binding from Env and Terraform at the same time.
    const tf = readFileSync(SLACK_WORKER_TF, "utf8");
    expect(tf).toContain('binding_name = "SLACK_COMPLETION_QUEUE"');
    expect(tf).toMatch(/resource\s+"cloudflare_queue"/);
    expect(tf).toMatch(/resource\s+"cloudflare_queue_consumer"/);
  });
});
