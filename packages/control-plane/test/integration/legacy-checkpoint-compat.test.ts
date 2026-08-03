import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, seedSandboxAuthHash } from "./helpers";

const SANDBOX_TOKEN = "legacy-checkpoint-token";

describe("legacy checkpoint upload compatibility", () => {
  beforeEach(cleanD1Tables);

  it("confirms an old bridge upload without storing recovery state", async () => {
    const sessionName = `legacy-checkpoint-${Date.now()}`;
    const { stub } = await initNamedSession(sessionName);
    await seedSandboxAuthHash(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: `sandbox-${sessionName}`,
    });
    const checkpoint = JSON.stringify({ info: { id: "ses-legacy" }, messages: [] });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(checkpoint));
    const checksum = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");

    const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/checkpoint`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SANDBOX_TOKEN}`,
        "Content-Type": "application/json",
        "X-OpenCode-Session-ID": "ses-legacy",
        "X-OpenCode-Version": "1.14.41",
        "X-Checkpoint-ID": "cp-legacy",
        "X-Checkpoint-Attempt-ID": "cpa-legacy",
        "X-Checkpoint-Created-At-Ms": String(Date.now()),
      },
      body: checkpoint,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ checksum });
    const stored = await env.MEDIA_BUCKET.list({
      prefix: `sessions/${sessionName}/checkpoints/`,
    });
    expect(stored.objects).toEqual([]);
  });

  it("does not serve old checkpoints for automatic restoration", async () => {
    const sessionName = `legacy-checkpoint-download-${Date.now()}`;
    const { stub } = await initNamedSession(sessionName);
    await seedSandboxAuthHash(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: `sandbox-${sessionName}`,
    });

    const response = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/checkpoint?generation=0`,
      { headers: { Authorization: `Bearer ${SANDBOX_TOKEN}` } }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Automatic checkpoint restoration is unavailable",
    });
  });
});
