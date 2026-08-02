import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, seedSandboxAuthHash } from "./helpers";

const SANDBOX_TOKEN = "checkpoint-sandbox-token";
const OPENCODE_SESSION_ID = "ses_checkpoint_test";
const CHECKPOINT_ID = "cp_checkpoint_test";
const ATTEMPT_ID = "cpa_checkpoint_test";
const CHECKPOINT_CREATED_AT = "1785686400000";

function exportBody(messageId: string): string {
  return JSON.stringify({
    info: { id: OPENCODE_SESSION_ID, title: "Checkpoint test" },
    messages: [{ info: { id: messageId, role: "user" }, parts: [] }],
  });
}

async function checksum(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function seedSession(sessionName: string): Promise<void> {
  const { stub } = await initNamedSession(sessionName);
  await seedSandboxAuthHash(stub, {
    authToken: SANDBOX_TOKEN,
    sandboxId: `sandbox-${sessionName}`,
  });
}

async function putCheckpoint(
  sessionName: string,
  body: string,
  identity: { checkpointId: string; attemptId: string; createdAt: string } = {
    checkpointId: CHECKPOINT_ID,
    attemptId: ATTEMPT_ID,
    createdAt: CHECKPOINT_CREATED_AT,
  }
): Promise<Response> {
  return SELF.fetch(`https://test.local/sessions/${sessionName}/checkpoint`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${SANDBOX_TOKEN}`,
      "Content-Type": "application/json",
      "X-OpenCode-Session-ID": OPENCODE_SESSION_ID,
      "X-OpenCode-Version": "1.14.41",
      "X-Checkpoint-ID": identity.checkpointId,
      "X-Checkpoint-Attempt-ID": identity.attemptId,
      "X-Checkpoint-Created-At-Ms": identity.createdAt,
    },
    body,
  });
}

async function putLegacyCheckpoint(sessionName: string, body: string): Promise<Response> {
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
  beforeEach(cleanD1Tables);

  it("stores and restores an authenticated native OpenCode export", async () => {
    const sessionName = `checkpoint-${Date.now()}`;
    await seedSession(sessionName);
    const checkpoint = exportBody("msg-1");

    const upload = await putCheckpoint(sessionName, checkpoint);
    expect(upload.status).toBe(201);
    await expect(upload.json()).resolves.toMatchObject({
      status: "confirmed",
      checkpointId: CHECKPOINT_ID,
      attemptId: ATTEMPT_ID,
    });

    const restore = await SELF.fetch(`https://test.local/sessions/${sessionName}/checkpoint`, {
      headers: { Authorization: `Bearer ${SANDBOX_TOKEN}` },
    });
    expect(restore.status).toBe(200);
    expect(await restore.text()).toBe(checkpoint);
    expect(restore.headers.get("X-OpenCode-Session-ID")).toBe(OPENCODE_SESSION_ID);
    expect(restore.headers.get("X-OpenCode-Version")).toBe("1.14.41");
    expect(restore.headers.get("X-Checkpoint-ID")).toBe(CHECKPOINT_ID);
    expect(restore.headers.get("X-Checkpoint-Recovery")).toBe("restored");
  });

  it("accepts uploads from sandboxes running the previous checkpoint protocol", async () => {
    const sessionName = `checkpoint-legacy-bridge-${Date.now()}`;
    await seedSession(sessionName);
    const checkpoint = exportBody("msg-legacy-bridge");

    const upload = await putLegacyCheckpoint(sessionName, checkpoint);

    expect(upload.status).toBe(201);
    await expect(upload.json()).resolves.toMatchObject({
      status: "confirmed",
      checksum: await checksum(checkpoint),
    });
    const restore = await SELF.fetch(`https://test.local/sessions/${sessionName}/checkpoint`, {
      headers: { Authorization: `Bearer ${SANDBOX_TOKEN}` },
    });
    expect(restore.status).toBe(200);
    expect(await restore.text()).toBe(checkpoint);

    const retry = await putLegacyCheckpoint(sessionName, checkpoint);
    expect(retry.status).toBe(200);
  });

  it("restores the latest distinct upload from the previous checkpoint protocol", async () => {
    const sessionName = `checkpoint-legacy-order-${Date.now()}`;
    await seedSession(sessionName);
    const previous = exportBody("msg-legacy-previous");
    const latest = exportBody("msg-legacy-latest");

    expect((await putLegacyCheckpoint(sessionName, previous)).status).toBe(201);
    expect((await putLegacyCheckpoint(sessionName, latest)).status).toBe(201);

    const restore = await SELF.fetch(`https://test.local/sessions/${sessionName}/checkpoint`, {
      headers: { Authorization: `Bearer ${SANDBOX_TOKEN}` },
    });
    expect(restore.status).toBe(200);
    expect(await restore.text()).toBe(latest);
  });

  it("accepts a legacy retry after an old control plane rewrites the pointer", async () => {
    const sessionName = `checkpoint-legacy-roundtrip-${Date.now()}`;
    await seedSession(sessionName);
    const checkpoint = exportBody("msg-legacy-roundtrip");
    expect((await putLegacyCheckpoint(sessionName, checkpoint)).status).toBe(201);
    const pointerKey = `sessions/${sessionName}/checkpoints/latest.json`;
    const pointer = await (await env.MEDIA_BUCKET.get(pointerKey))!.json<{
      generations: Array<{
        checksum: string;
        byteLength: number;
        opencodeSessionId: string;
        opencodeVersion: string;
      }>;
    }>();
    await env.MEDIA_BUCKET.put(
      pointerKey,
      JSON.stringify({
        schemaVersion: 1,
        generations: pointer.generations.map(
          ({ checksum, byteLength, opencodeSessionId, opencodeVersion }) => ({
            checksum,
            byteLength,
            opencodeSessionId,
            opencodeVersion,
          })
        ),
      })
    );

    expect((await putLegacyCheckpoint(sessionName, checkpoint)).status).toBe(200);
  });

  it("writes a pointer the previous control plane can parse", async () => {
    const sessionName = `checkpoint-legacy-pointer-${Date.now()}`;
    await seedSession(sessionName);

    expect((await putCheckpoint(sessionName, exportBody("msg-current"))).status).toBe(201);

    const pointer = await env.MEDIA_BUCKET.get(`sessions/${sessionName}/checkpoints/latest.json`);
    expect(pointer).not.toBeNull();
    await expect(pointer!.json()).resolves.toMatchObject({
      schemaVersion: 1,
      generations: [
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          byteLength: expect.any(Number),
          opencodeSessionId: OPENCODE_SESSION_ID,
          opencodeVersion: "1.14.41",
        },
      ],
    });
  });

  it("falls back when the newest checkpoint generation is missing", async () => {
    const sessionName = `checkpoint-fallback-${Date.now()}`;
    await seedSession(sessionName);
    const previous = exportBody("msg-previous");
    const latest = exportBody("msg-latest");

    expect(
      (
        await putCheckpoint(sessionName, previous, {
          checkpointId: "cp_previous",
          attemptId: "cpa_previous",
          createdAt: "1785686400000",
        })
      ).status
    ).toBe(201);
    const latestUpload = await putCheckpoint(sessionName, latest, {
      checkpointId: "cp_latest",
      attemptId: "cpa_latest",
      createdAt: "1785686401000",
    });
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
    expect(restore.headers.get("X-Checkpoint-ID")).toBe("cp_previous");
    expect(restore.headers.get("X-Checkpoint-Recovery")).toBe("fallback");
  });

  it("falls back when the newest checkpoint manifest cannot be verified", async () => {
    const sessionName = `checkpoint-manifest-fallback-${Date.now()}`;
    await seedSession(sessionName);
    const previous = exportBody("msg-previous");
    const latest = exportBody("msg-latest");
    expect(
      (
        await putCheckpoint(sessionName, previous, {
          checkpointId: "cp_previous",
          attemptId: "cpa_previous",
          createdAt: "1785686400000",
        })
      ).status
    ).toBe(201);
    expect(
      (
        await putCheckpoint(sessionName, latest, {
          checkpointId: "cp_latest",
          attemptId: "cpa_latest",
          createdAt: "1785686401000",
        })
      ).status
    ).toBe(201);
    await env.MEDIA_BUCKET.put(
      `sessions/${sessionName}/checkpoints/manifests/cp_latest.json`,
      "not-json"
    );

    const restore = await SELF.fetch(`https://test.local/sessions/${sessionName}/checkpoint`, {
      headers: { Authorization: `Bearer ${SANDBOX_TOKEN}` },
    });

    expect(restore.status).toBe(200);
    expect(await restore.text()).toBe(previous);
    expect(restore.headers.get("X-Checkpoint-ID")).toBe("cp_previous");
    expect(restore.headers.get("X-Checkpoint-Recovery")).toBe("fallback");
  });

  it("serves the previous valid generation after a rejected newest import", async () => {
    const sessionName = `checkpoint-generation-${Date.now()}`;
    await seedSession(sessionName);
    const previous = exportBody("msg-previous");
    const latest = exportBody("msg-latest");
    expect(
      (
        await putCheckpoint(sessionName, previous, {
          checkpointId: "cp_previous",
          attemptId: "cpa_previous",
          createdAt: "1785686400000",
        })
      ).status
    ).toBe(201);
    expect(
      (
        await putCheckpoint(sessionName, latest, {
          checkpointId: "cp_latest",
          attemptId: "cpa_latest",
          createdAt: "1785686401000",
        })
      ).status
    ).toBe(201);

    const newestRestore = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/checkpoint`,
      { headers: { Authorization: `Bearer ${SANDBOX_TOKEN}` } }
    );
    expect(newestRestore.headers.get("X-Checkpoint-Next-Generation")).toBe("1");
    expect(newestRestore.headers.get("X-Checkpoint-Recovery")).toBe("restored");
    expect(await newestRestore.text()).toBe(latest);

    const restore = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/checkpoint?generation=1`,
      { headers: { Authorization: `Bearer ${SANDBOX_TOKEN}` } }
    );

    expect(restore.status).toBe(200);
    expect(restore.headers.get("X-Checkpoint-Next-Generation")).toBeNull();
    expect(restore.headers.get("X-Checkpoint-Recovery")).toBe("fallback");
    expect(await restore.text()).toBe(previous);
  });

  it("confirms a duplicate retry without creating a competing manifest", async () => {
    const sessionName = `checkpoint-retry-${Date.now()}`;
    await seedSession(sessionName);
    const checkpoint = exportBody("msg-1");

    expect((await putCheckpoint(sessionName, checkpoint)).status).toBe(201);
    const retry = await putCheckpoint(sessionName, checkpoint);

    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({
      status: "confirmed",
      checkpointId: CHECKPOINT_ID,
      attemptId: ATTEMPT_ID,
    });
    const manifest = await env.MEDIA_BUCKET.get(`sessions/${sessionName}/checkpoints/latest.json`);
    expect(manifest).not.toBeNull();
    const stored = await manifest!.json<{ generations: unknown[] }>();
    expect(stored.generations).toHaveLength(1);
  });

  it("looks up a verified confirmation by its complete identity", async () => {
    const sessionName = `checkpoint-confirmation-${Date.now()}`;
    await seedSession(sessionName);
    const checkpoint = exportBody("msg-1");
    const upload = await putCheckpoint(sessionName, checkpoint);
    const metadata = await upload.json<{ checksum: string }>();

    const confirmation = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/checkpoint?${new URLSearchParams({
        checkpointId: CHECKPOINT_ID,
        attemptId: ATTEMPT_ID,
        checksum: metadata.checksum,
      })}`,
      { headers: { Authorization: `Bearer ${SANDBOX_TOKEN}` } }
    );

    expect(confirmation.status).toBe(200);
    await expect(confirmation.json()).resolves.toEqual({
      status: "confirmed",
      checkpointId: CHECKPOINT_ID,
      attemptId: ATTEMPT_ID,
      checksum: metadata.checksum,
    });
  });

  it("repairs an incomplete confirmed upload when the same attempt retries", async () => {
    const sessionName = `checkpoint-repair-${Date.now()}`;
    await seedSession(sessionName);
    const checkpoint = exportBody("msg-1");
    const upload = await putCheckpoint(sessionName, checkpoint);
    const metadata = await upload.json<{ checksum: string }>();
    await env.MEDIA_BUCKET.delete(
      `sessions/${sessionName}/checkpoints/generations/${metadata.checksum}.json`
    );

    expect((await putCheckpoint(sessionName, checkpoint)).status).toBe(200);
    const restore = await SELF.fetch(`https://test.local/sessions/${sessionName}/checkpoint`, {
      headers: { Authorization: `Bearer ${SANDBOX_TOKEN}` },
    });
    expect(restore.status).toBe(200);
    expect(await restore.text()).toBe(checkpoint);
  });

  it("keeps the newest checkpoint when distinct uploads overlap", async () => {
    const sessionName = `checkpoint-overlap-${Date.now()}`;
    await seedSession(sessionName);
    const older = exportBody("msg-older");
    const newer = exportBody("msg-newer");

    const uploads = await Promise.all([
      putCheckpoint(sessionName, older, {
        checkpointId: "cp_older",
        attemptId: "cpa_older",
        createdAt: "1785686400000",
      }),
      putCheckpoint(sessionName, newer, {
        checkpointId: "cp_newer",
        attemptId: "cpa_newer",
        createdAt: "1785686401000",
      }),
    ]);

    expect(uploads.every((upload) => upload.status === 200 || upload.status === 201)).toBe(true);
    const restore = await SELF.fetch(`https://test.local/sessions/${sessionName}/checkpoint`, {
      headers: { Authorization: `Bearer ${SANDBOX_TOKEN}` },
    });
    expect(restore.status).toBe(200);
    expect(await restore.text()).toBe(newer);
    expect(restore.headers.get("X-Checkpoint-ID")).toBe("cp_newer");
  });

  it("rejects conflicting reuse of an upload attempt", async () => {
    const sessionName = `checkpoint-conflict-${Date.now()}`;
    await seedSession(sessionName);
    expect((await putCheckpoint(sessionName, exportBody("msg-1"))).status).toBe(201);

    const conflict = await putCheckpoint(sessionName, exportBody("msg-2"));

    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      errorClass: "attempt_conflict",
      attemptId: ATTEMPT_ID,
      checkpointId: CHECKPOINT_ID,
    });
  });

  it("rejects checkpoint creation times beyond the allowed clock skew", async () => {
    const sessionName = `checkpoint-clock-skew-${Date.now()}`;
    await seedSession(sessionName);

    const response = await putCheckpoint(sessionName, exportBody("msg-future"), {
      checkpointId: "cp_future",
      attemptId: "cpa_future",
      createdAt: String(Date.now() + 24 * 60 * 60 * 1000),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Checkpoint identity and creation time are required",
    });
  });

  it("allows only one conflicting concurrent upload to claim an attempt", async () => {
    const sessionName = `checkpoint-concurrent-conflict-${Date.now()}`;
    await seedSession(sessionName);
    const first = exportBody("msg-first");
    const second = exportBody("msg-second");

    const uploads = await Promise.all([
      putCheckpoint(sessionName, first),
      putCheckpoint(sessionName, second),
    ]);

    expect(uploads.map((upload) => upload.status).sort()).toEqual([201, 409]);
    const restore = await SELF.fetch(`https://test.local/sessions/${sessionName}/checkpoint`, {
      headers: { Authorization: `Bearer ${SANDBOX_TOKEN}` },
    });
    expect(restore.status).toBe(200);
    expect([first, second]).toContain(await restore.text());
  });

  it("retains bounded provider diagnostics when the payload write fails", async () => {
    const sessionName = `checkpoint-write-failure-${Date.now()}`;
    await seedSession(sessionName);
    const failure = Object.assign(new Error("R2 payload write unavailable"), { code: 10001 });
    const put = vi.spyOn(env.MEDIA_BUCKET, "put").mockRejectedValueOnce(failure);
    const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const upload = await putCheckpoint(sessionName, exportBody("msg-1"));

      expect(upload.status).toBe(503);
      await expect(upload.json()).resolves.toEqual({
        error: "Checkpoint payload could not be stored",
        errorClass: "payload_put",
        checkpointId: CHECKPOINT_ID,
        attemptId: ATTEMPT_ID,
        providerCode: 10001,
      });
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining("R2 payload write unavailable")
      );
    } finally {
      put.mockRestore();
      logError.mockRestore();
    }
  });

  it("does not replace checkpoint history when the current manifest is invalid", async () => {
    const sessionName = `checkpoint-manifest-invalid-${Date.now()}`;
    await seedSession(sessionName);
    const manifestKey = `sessions/${sessionName}/checkpoints/latest.json`;
    await env.MEDIA_BUCKET.put(manifestKey, "not-json");

    const upload = await putCheckpoint(sessionName, exportBody("msg-1"));

    expect(upload.status).toBe(503);
    await expect(upload.json()).resolves.toMatchObject({ errorClass: "manifest_read" });
    expect(await (await env.MEDIA_BUCKET.get(manifestKey))!.text()).toBe("not-json");
  });

  it("keeps a verified legacy checkpoint available during manifest migration", async () => {
    const sessionName = `checkpoint-legacy-${Date.now()}`;
    await seedSession(sessionName);
    const legacy = exportBody("msg-legacy");
    const olderLegacy = exportBody("msg-older-legacy");
    const legacyChecksum = await checksum(legacy);
    const olderLegacyChecksum = await checksum(olderLegacy);
    const prefix = `sessions/${sessionName}/checkpoints`;
    await env.MEDIA_BUCKET.put(`${prefix}/generations/${legacyChecksum}.json`, legacy);
    await env.MEDIA_BUCKET.put(`${prefix}/generations/${olderLegacyChecksum}.json`, olderLegacy);
    await env.MEDIA_BUCKET.put(
      `${prefix}/latest.json`,
      JSON.stringify({
        schemaVersion: 1,
        generations: [
          {
            checksum: legacyChecksum,
            byteLength: new TextEncoder().encode(legacy).byteLength,
            opencodeSessionId: OPENCODE_SESSION_ID,
            opencodeVersion: "1.14.41",
          },
          {
            checksum: olderLegacyChecksum,
            byteLength: new TextEncoder().encode(olderLegacy).byteLength,
            opencodeSessionId: OPENCODE_SESSION_ID,
            opencodeVersion: "1.14.41",
          },
        ],
      })
    );

    const current = await SELF.fetch(`https://test.local/sessions/${sessionName}/checkpoint`, {
      headers: { Authorization: `Bearer ${SANDBOX_TOKEN}` },
    });
    expect(current.status).toBe(200);
    expect(await current.text()).toBe(legacy);

    expect((await putCheckpoint(sessionName, exportBody("msg-current"))).status).toBe(201);
    const fallback = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/checkpoint?generation=1`,
      { headers: { Authorization: `Bearer ${SANDBOX_TOKEN}` } }
    );
    expect(fallback.status).toBe(200);
    expect(await fallback.text()).toBe(legacy);
    expect(fallback.headers.get("X-Checkpoint-Recovery")).toBe("fallback");
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
