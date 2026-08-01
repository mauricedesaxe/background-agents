import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { initNamedSession, seedSandboxAuthHash } from "./helpers";

const SANDBOX_TOKEN = "checkpoint-sandbox-token";
const OPENCODE_SESSION_ID = "ses_checkpoint_test";

function exportBody(messageId: string): string {
  return JSON.stringify({
    info: { id: OPENCODE_SESSION_ID, title: "Checkpoint test" },
    messages: [{ info: { id: messageId, role: "user" }, parts: [] }],
  });
}

async function seedSession(sessionName: string): Promise<void> {
  const { stub } = await initNamedSession(sessionName);
  await seedSandboxAuthHash(stub, {
    authToken: SANDBOX_TOKEN,
    sandboxId: `sandbox-${sessionName}`,
  });
}

async function putCheckpoint(sessionName: string, body: string): Promise<Response> {
  return SELF.fetch(`https://test.local/sessions/${sessionName}/checkpoint`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${SANDBOX_TOKEN}`,
      "Content-Type": "application/json",
      "X-OpenCode-Session-ID": OPENCODE_SESSION_ID,
      "X-OpenCode-Version": "1.14.41",
    },
    body,
  });
}

describe("session checkpoints", () => {
  it("stores and restores an authenticated native OpenCode export", async () => {
    const sessionName = `checkpoint-${Date.now()}`;
    await seedSession(sessionName);
    const checkpoint = exportBody("msg-1");

    const upload = await putCheckpoint(sessionName, checkpoint);
    expect(upload.status).toBe(201);

    const restore = await SELF.fetch(`https://test.local/sessions/${sessionName}/checkpoint`, {
      headers: { Authorization: `Bearer ${SANDBOX_TOKEN}` },
    });
    expect(restore.status).toBe(200);
    expect(await restore.text()).toBe(checkpoint);
    expect(restore.headers.get("X-OpenCode-Session-ID")).toBe(OPENCODE_SESSION_ID);
    expect(restore.headers.get("X-OpenCode-Version")).toBe("1.14.41");
  });

  it("falls back when the newest checkpoint generation is missing", async () => {
    const sessionName = `checkpoint-fallback-${Date.now()}`;
    await seedSession(sessionName);
    const previous = exportBody("msg-previous");
    const latest = exportBody("msg-latest");

    expect((await putCheckpoint(sessionName, previous)).status).toBe(201);
    const latestUpload = await putCheckpoint(sessionName, latest);
    expect(latestUpload.status).toBe(201);
    const latestMetadata = await latestUpload.json<{ checksum: string }>();
    await env.MEDIA_BUCKET.delete(
      `sessions/${sessionName}/checkpoints/generations/${latestMetadata.checksum}.json`
    );

    const restore = await SELF.fetch(`https://test.local/sessions/${sessionName}/checkpoint`, {
      headers: { Authorization: `Bearer ${SANDBOX_TOKEN}` },
    });
    expect(restore.status).toBe(200);
    expect(await restore.text()).toBe(previous);
  });

  it("rejects exports whose native session ID does not match the header", async () => {
    const sessionName = `checkpoint-mismatch-${Date.now()}`;
    await seedSession(sessionName);
    const checkpoint = JSON.stringify({ info: { id: "ses_other" }, messages: [] });

    const response = await putCheckpoint(sessionName, checkpoint);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Checkpoint session ID does not match the export",
    });
  });
});
