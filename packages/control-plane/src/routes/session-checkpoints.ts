import { z } from "zod";
import { createLogger } from "../logger";
import { createMediaObjectStorage, type ObjectStorage } from "../storage/object-storage";
import { elapsed, epochMs, type EpochMs } from "../time";
import type { Env } from "../types";
import { error, json, parsePattern, type Route } from "./shared";

const CHECKPOINT_MAX_BYTES = 50 * 1024 * 1024;
const CHECKPOINT_GENERATIONS_TO_KEEP = 2;
const CHECKPOINT_POINTER_SCHEMA_VERSION = 1;
const CHECKPOINT_RECORD_SCHEMA_VERSION = 2;
const CHECKPOINT_DETAIL_MAX_LENGTH = 500;
const POINTER_UPDATE_MAX_ATTEMPTS = 5;
const CHECKPOINT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const logger = createLogger("router:session-checkpoints");

const checksumSchema = z.string().regex(/^[a-f0-9]{64}$/);
const checkpointIdentitySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

const legacyCheckpointGenerationSchema = z.object({
  checksum: checksumSchema,
  byteLength: z.number().int().positive(),
  opencodeSessionId: z.string().min(1),
  opencodeVersion: z.string().min(1),
});

const legacyCheckpointManifestSchema = z.object({
  schemaVersion: z.literal(CHECKPOINT_POINTER_SCHEMA_VERSION),
  generations: z.array(legacyCheckpointGenerationSchema).max(CHECKPOINT_GENERATIONS_TO_KEEP),
});

const checkpointGenerationSchema = legacyCheckpointGenerationSchema.extend({
  checkpointId: checkpointIdentitySchema,
  attemptId: checkpointIdentitySchema,
  createdAtMs: z.number().int().nonnegative().transform(epochMs),
  recordKey: z.string().min(1).nullable(),
});

const checkpointManifestSchema = z.object({
  schemaVersion: z.literal(CHECKPOINT_POINTER_SCHEMA_VERSION),
  generations: z.array(checkpointGenerationSchema).max(CHECKPOINT_GENERATIONS_TO_KEEP),
});

const checkpointRecordSchema = z.object({
  schemaVersion: z.literal(CHECKPOINT_RECORD_SCHEMA_VERSION),
  generation: checkpointGenerationSchema,
});

type CheckpointGeneration = z.infer<typeof checkpointGenerationSchema>;
type CheckpointManifest = z.infer<typeof checkpointManifestSchema>;
type CheckpointManifestSnapshot = {
  manifest: CheckpointManifest;
  etag: string | null;
};
type CheckpointFailure = {
  errorClass: string;
  status: number;
  message: string;
  providerCode?: number;
};
type CheckpointResult<T> = { ok: true; value: T } | { ok: false; error: CheckpointFailure };

function storageFailure(
  errorClass: string,
  fallbackMessage: string,
  failure: unknown
): CheckpointFailure {
  const providerCode =
    failure &&
    typeof failure === "object" &&
    typeof (failure as { code?: unknown }).code === "number"
      ? (failure as { code: number }).code
      : undefined;
  logger.error("checkpoint.storage_failed", {
    error_class: errorClass,
    ...(providerCode === undefined ? {} : { provider_code: providerCode }),
    error: failure instanceof Error ? failure : String(failure),
  });
  return { errorClass, status: 503, message: fallbackMessage, providerCode };
}

function checkpointPrefix(sessionId: string): string {
  return `sessions/${sessionId}/checkpoints`;
}

function currentPointerKey(sessionId: string): string {
  return `${checkpointPrefix(sessionId)}/latest.json`;
}

function checkpointRecordKey(sessionId: string, checkpointId: string): string {
  return `${checkpointPrefix(sessionId)}/manifests/${checkpointId}.json`;
}

function generationKey(sessionId: string, checksum: string): string {
  return `${checkpointPrefix(sessionId)}/generations/${checksum}.json`;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function exportSessionId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const info = record.info;
  if (
    info &&
    typeof info === "object" &&
    typeof (info as Record<string, unknown>).id === "string"
  ) {
    return (info as Record<string, unknown>).id as string;
  }
  return null;
}

function legacyGeneration(
  generation: z.infer<typeof legacyCheckpointGenerationSchema>,
  index: number
): CheckpointGeneration {
  return {
    ...generation,
    checkpointId: `legacy:${generation.checksum}`,
    attemptId: `legacy:${generation.checksum}`,
    createdAtMs: epochMs(CHECKPOINT_GENERATIONS_TO_KEEP - index),
    recordKey: null,
  };
}

async function readManifestSnapshot(
  storage: ObjectStorage,
  sessionId: string
): Promise<CheckpointResult<CheckpointManifestSnapshot>> {
  let object;
  try {
    object = await storage.get(currentPointerKey(sessionId));
  } catch (failure) {
    return {
      ok: false,
      error: storageFailure("pointer_read", "Checkpoint history could not be read", failure),
    };
  }
  if (!object) {
    return {
      ok: true,
      value: {
        manifest: { schemaVersion: CHECKPOINT_POINTER_SCHEMA_VERSION, generations: [] },
        etag: null,
      },
    };
  }

  try {
    const parsed: unknown = JSON.parse(await new Response(object.body).text());
    const current = checkpointManifestSchema.safeParse(parsed);
    if (current.success) {
      return { ok: true, value: { manifest: current.data, etag: object.etag } };
    }
    const legacy = legacyCheckpointManifestSchema.safeParse(parsed);
    if (legacy.success) {
      return {
        ok: true,
        value: {
          manifest: {
            schemaVersion: CHECKPOINT_POINTER_SCHEMA_VERSION,
            generations: legacy.data.generations.map(legacyGeneration),
          },
          etag: object.etag,
        },
      };
    }
  } catch {
    return {
      ok: false,
      error: {
        errorClass: "manifest_read",
        status: 503,
        message: "Checkpoint history is invalid",
      },
    };
  }

  return {
    ok: false,
    error: {
      errorClass: "manifest_read",
      status: 503,
      message: "Checkpoint history is invalid",
    },
  };
}

async function verifyPayload(
  storage: ObjectStorage,
  sessionId: string,
  generation: CheckpointGeneration
): Promise<CheckpointResult<Uint8Array | null>> {
  let object;
  try {
    object = await storage.get(generationKey(sessionId, generation.checksum));
  } catch (failure) {
    return {
      ok: false,
      error: storageFailure("payload_read", "Checkpoint payload could not be read", failure),
    };
  }
  if (!object || object.size !== generation.byteLength) return { ok: true, value: null };
  let bytes;
  try {
    bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
  } catch (failure) {
    return {
      ok: false,
      error: storageFailure("payload_read", "Checkpoint payload could not be read", failure),
    };
  }
  return { ok: true, value: (await sha256(bytes)) === generation.checksum ? bytes : null };
}

async function verifyCheckpointRecord(
  storage: ObjectStorage,
  generation: CheckpointGeneration
): Promise<CheckpointResult<boolean>> {
  if (!generation.recordKey) return { ok: true, value: true };
  const record = await readCheckpointRecord(storage, generation.recordKey);
  if (!record.ok) return { ok: false, error: record.error };
  return {
    ok: true,
    value: record.value !== null && sameGeneration(record.value, generation),
  };
}

async function readCheckpointRecord(
  storage: ObjectStorage,
  recordKey: string
): Promise<CheckpointResult<CheckpointGeneration | null>> {
  let object;
  try {
    object = await storage.get(recordKey);
  } catch (failure) {
    return {
      ok: false,
      error: storageFailure(
        "checkpoint_manifest_read",
        "Checkpoint manifest could not be read",
        failure
      ),
    };
  }
  if (!object) return { ok: true, value: null };
  try {
    const parsed = checkpointRecordSchema.safeParse(
      JSON.parse(await new Response(object.body).text())
    );
    return { ok: true, value: parsed.success ? parsed.data.generation : null };
  } catch (failure) {
    if (!(failure instanceof SyntaxError)) {
      return {
        ok: false,
        error: storageFailure(
          "checkpoint_manifest_read",
          "Checkpoint manifest could not be read",
          failure
        ),
      };
    }
    return { ok: true, value: null };
  }
}

function sameGeneration(left: CheckpointGeneration, right: CheckpointGeneration): boolean {
  return (
    left.checkpointId === right.checkpointId &&
    left.attemptId === right.attemptId &&
    left.createdAtMs === right.createdAtMs &&
    left.checksum === right.checksum &&
    left.byteLength === right.byteLength &&
    left.opencodeSessionId === right.opencodeSessionId &&
    left.opencodeVersion === right.opencodeVersion &&
    left.recordKey === right.recordKey
  );
}

function sameAttempt(existing: CheckpointGeneration, candidate: CheckpointGeneration): boolean {
  return (
    existing.attemptId === candidate.attemptId &&
    existing.checkpointId === candidate.checkpointId &&
    existing.createdAtMs === candidate.createdAtMs &&
    existing.checksum === candidate.checksum &&
    existing.byteLength === candidate.byteLength &&
    existing.opencodeSessionId === candidate.opencodeSessionId &&
    existing.opencodeVersion === candidate.opencodeVersion
  );
}

function checkpointErrorResponse(
  failure: CheckpointFailure,
  checkpointId: string,
  attemptId: string
): Response {
  return json(
    {
      error: failure.message.slice(0, CHECKPOINT_DETAIL_MAX_LENGTH),
      errorClass: failure.errorClass,
      checkpointId,
      attemptId,
      ...(failure.providerCode === undefined ? {} : { providerCode: failure.providerCode }),
    },
    failure.status
  );
}

async function handleCheckpointUpload(
  request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  const opencodeSessionId = request.headers.get("X-OpenCode-Session-ID")?.trim();
  const opencodeVersion = request.headers.get("X-OpenCode-Version")?.trim();
  const providedCheckpointId = request.headers.get("X-Checkpoint-ID")?.trim() ?? "";
  const providedAttemptId = request.headers.get("X-Checkpoint-Attempt-ID")?.trim() ?? "";
  const providedCreatedAtMs = request.headers.get("X-Checkpoint-Created-At-Ms")?.trim() ?? "";
  if (!opencodeSessionId || !opencodeVersion) {
    return error("OpenCode session ID and version are required", 400);
  }
  const hasProvidedIdentity = Boolean(
    providedCheckpointId || providedAttemptId || providedCreatedAtMs
  );
  const parsedCreatedAtMs = Number(providedCreatedAtMs);
  if (
    hasProvidedIdentity &&
    (!checkpointIdentitySchema.safeParse(providedCheckpointId).success ||
      !checkpointIdentitySchema.safeParse(providedAttemptId).success ||
      !Number.isSafeInteger(parsedCreatedAtMs) ||
      parsedCreatedAtMs < 0 ||
      parsedCreatedAtMs > Date.now() + CHECKPOINT_MAX_CLOCK_SKEW_MS)
  ) {
    return error("Checkpoint identity and creation time are required", 400);
  }

  const contentLength = Number(request.headers.get("Content-Length") ?? 0);
  if (contentLength > CHECKPOINT_MAX_BYTES) {
    return error(`Checkpoint must be ${CHECKPOINT_MAX_BYTES} bytes or smaller`, 413);
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > CHECKPOINT_MAX_BYTES) {
    return error(`Checkpoint must be between 1 and ${CHECKPOINT_MAX_BYTES} bytes`, 400);
  }

  let checkpoint: unknown;
  try {
    checkpoint = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return error("Checkpoint is not valid JSON", 400);
  }
  if (exportSessionId(checkpoint) !== opencodeSessionId) {
    return error("Checkpoint session ID does not match the export", 400);
  }

  const storage = createMediaObjectStorage(env);
  let checkpointId = providedCheckpointId || "unknown";
  let attemptId = providedAttemptId || "unknown";
  try {
    const checksum = await sha256(bytes);
    checkpointId = providedCheckpointId || `legacy:${checksum}`;
    attemptId = providedAttemptId || `legacy:${checksum}`;
    const recordKey = checkpointRecordKey(sessionId, checkpointId);
    const initialSnapshot = await readManifestSnapshot(storage, sessionId);
    if (!initialSnapshot.ok) {
      return checkpointErrorResponse(initialSnapshot.error, checkpointId, attemptId);
    }
    let pointerSnapshot = initialSnapshot.value;
    let pointerGeneration = pointerSnapshot.manifest.generations.find(
      (entry) => entry.attemptId === attemptId || entry.checkpointId === checkpointId
    );
    let historicalGeneration: CheckpointGeneration | null = null;
    if (!hasProvidedIdentity) {
      const historicalRecord = await readCheckpointRecord(storage, recordKey);
      if (!historicalRecord.ok) {
        return checkpointErrorResponse(historicalRecord.error, checkpointId, attemptId);
      }
      historicalGeneration = historicalRecord.value;
      if (pointerGeneration?.recordKey === null && historicalGeneration) {
        const storedGeneration = historicalGeneration;
        pointerSnapshot = {
          ...pointerSnapshot,
          manifest: {
            ...pointerSnapshot.manifest,
            generations: pointerSnapshot.manifest.generations.map((entry) =>
              entry.checkpointId === checkpointId ? storedGeneration : entry
            ),
          },
        };
        pointerGeneration = historicalGeneration;
      }
    }
    const nextLegacyCreatedAtMs = epochMs(
      Math.max(
        Date.now(),
        ...pointerSnapshot.manifest.generations.map((entry) => Number(entry.createdAtMs) + 1)
      )
    );
    const createdAtMs: EpochMs = hasProvidedIdentity
      ? epochMs(parsedCreatedAtMs)
      : (historicalGeneration?.createdAtMs ??
        pointerGeneration?.createdAtMs ??
        nextLegacyCreatedAtMs);
    const generation: CheckpointGeneration = {
      checkpointId,
      attemptId,
      createdAtMs,
      checksum,
      byteLength: bytes.byteLength,
      opencodeSessionId,
      opencodeVersion,
      recordKey,
    };

    const conflicting = historicalGeneration ?? pointerGeneration;
    if (conflicting && !sameAttempt(conflicting, generation)) {
      return checkpointErrorResponse(
        {
          errorClass: "attempt_conflict",
          status: 409,
          message: "Checkpoint attempt identity was reused with different content",
        },
        checkpointId,
        attemptId
      );
    }

    try {
      await storage.put(generationKey(sessionId, checksum), bytes, {
        contentType: "application/json",
      });
    } catch (failure) {
      return checkpointErrorResponse(
        storageFailure("payload_put", "Checkpoint payload could not be stored", failure),
        checkpointId,
        attemptId
      );
    }
    const verifiedPayload = await verifyPayload(storage, sessionId, generation);
    if (!verifiedPayload.ok) {
      return checkpointErrorResponse(verifiedPayload.error, checkpointId, attemptId);
    }
    if (!verifiedPayload.value) {
      return checkpointErrorResponse(
        {
          errorClass: "payload_verify",
          status: 503,
          message: "Checkpoint payload could not be verified",
        },
        checkpointId,
        attemptId
      );
    }

    const record = JSON.stringify({
      schemaVersion: CHECKPOINT_RECORD_SCHEMA_VERSION,
      generation,
    });
    let recordCreated;
    try {
      recordCreated = await storage.compareAndSet(recordKey, record, null, {
        contentType: "application/json",
      });
    } catch (failure) {
      return checkpointErrorResponse(
        storageFailure(
          "checkpoint_manifest_put",
          "Checkpoint manifest could not be stored",
          failure
        ),
        checkpointId,
        attemptId
      );
    }
    const verifiedRecord = await verifyCheckpointRecord(storage, generation);
    if (!verifiedRecord.ok) {
      return checkpointErrorResponse(verifiedRecord.error, checkpointId, attemptId);
    }
    if (!verifiedRecord.value) {
      return checkpointErrorResponse(
        {
          errorClass: recordCreated ? "checkpoint_manifest_verify" : "attempt_conflict",
          status: recordCreated ? 503 : 409,
          message: recordCreated
            ? "Checkpoint manifest could not be verified"
            : "Checkpoint attempt identity was reused with different content",
        },
        checkpointId,
        attemptId
      );
    }

    let confirmed: CheckpointManifest | null = null;
    let promoted = false;
    for (let updateAttempt = 0; updateAttempt < POINTER_UPDATE_MAX_ATTEMPTS; updateAttempt++) {
      if (updateAttempt > 0) {
        const nextSnapshot = await readManifestSnapshot(storage, sessionId);
        if (!nextSnapshot.ok) {
          return checkpointErrorResponse(nextSnapshot.error, checkpointId, attemptId);
        }
        pointerSnapshot = nextSnapshot.value;
      }
      const existing = pointerSnapshot.manifest.generations.find(
        (entry) => entry.attemptId === attemptId || entry.checkpointId === checkpointId
      );
      if (existing && !sameAttempt(existing, generation)) {
        return checkpointErrorResponse(
          {
            errorClass: "attempt_conflict",
            status: 409,
            message: "Checkpoint attempt identity was reused with different content",
          },
          checkpointId,
          attemptId
        );
      }
      if (existing) {
        const existingRecord = await verifyCheckpointRecord(storage, existing);
        if (!existingRecord.ok) {
          return checkpointErrorResponse(existingRecord.error, checkpointId, attemptId);
        }
        if (existingRecord.value) {
          const existingPayload = await verifyPayload(storage, sessionId, existing);
          if (!existingPayload.ok) {
            return checkpointErrorResponse(existingPayload.error, checkpointId, attemptId);
          }
          if (existingPayload.value) {
            confirmed = pointerSnapshot.manifest;
            break;
          }
        }
      }

      const generations = [
        generation,
        ...pointerSnapshot.manifest.generations.filter((entry) => entry.checksum !== checksum),
      ]
        .sort(
          (left, right) =>
            elapsed(left.createdAtMs, right.createdAtMs) ||
            right.checkpointId.localeCompare(left.checkpointId)
        )
        .slice(0, CHECKPOINT_GENERATIONS_TO_KEEP);
      let stored;
      try {
        stored = await storage.compareAndSet(
          currentPointerKey(sessionId),
          JSON.stringify({ schemaVersion: CHECKPOINT_POINTER_SCHEMA_VERSION, generations }),
          pointerSnapshot.etag,
          { contentType: "application/json" }
        );
      } catch (failure) {
        return checkpointErrorResponse(
          storageFailure("pointer_put", "Current checkpoint pointer could not be stored", failure),
          checkpointId,
          attemptId
        );
      }
      if (!stored) continue;

      const readBackResult = await readManifestSnapshot(storage, sessionId);
      if (!readBackResult.ok) {
        return checkpointErrorResponse(readBackResult.error, checkpointId, attemptId);
      }
      const readBack = readBackResult.value;
      if (readBack.manifest.generations.some((entry) => sameGeneration(entry, generation))) {
        confirmed = readBack.manifest;
        promoted = true;
        break;
      }
    }
    if (!confirmed) {
      return checkpointErrorResponse(
        {
          errorClass: "pointer_contention",
          status: 503,
          message: "Current checkpoint pointer changed too many times",
        },
        checkpointId,
        attemptId
      );
    }

    return json(
      {
        status: "confirmed",
        checkpointId,
        attemptId,
        checksum,
      },
      promoted ? 201 : 200
    );
  } catch (failure) {
    logger.error("checkpoint.persistence_failed", {
      session_id: sessionId,
      checkpoint_id: checkpointId,
      attempt_id: attemptId,
      error: failure instanceof Error ? failure : String(failure),
    });
    return checkpointErrorResponse(
      {
        errorClass: "persistence_unknown",
        status: 503,
        message: "Checkpoint persistence failed",
      },
      checkpointId,
      attemptId
    );
  }
}

async function handleCheckpointDownload(
  request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");
  const searchParams = new URL(request.url).searchParams;
  const requestedCheckpointId = searchParams.get("checkpointId")?.trim() ?? "";
  const requestedAttemptId = searchParams.get("attemptId")?.trim() ?? "";
  const requestedChecksum = searchParams.get("checksum")?.trim() ?? "";
  const confirmationLookup = Boolean(
    requestedCheckpointId || requestedAttemptId || requestedChecksum
  );
  if (
    confirmationLookup &&
    (!checkpointIdentitySchema.safeParse(requestedCheckpointId).success ||
      !checkpointIdentitySchema.safeParse(requestedAttemptId).success ||
      !checksumSchema.safeParse(requestedChecksum).success)
  ) {
    return error("Checkpoint identity and checksum are required", 400);
  }
  const requestedGeneration = Number(searchParams.get("generation") ?? 0);
  if (
    !Number.isInteger(requestedGeneration) ||
    requestedGeneration < 0 ||
    requestedGeneration >= CHECKPOINT_GENERATIONS_TO_KEEP
  ) {
    return error("Checkpoint generation is invalid", 400);
  }

  const storage = createMediaObjectStorage(env);
  const manifestResult = await readManifestSnapshot(storage, sessionId);
  if (!manifestResult.ok) {
    return checkpointErrorResponse(manifestResult.error, "unknown", "unknown");
  }
  const manifest = manifestResult.value.manifest;
  if (confirmationLookup) {
    const generation = manifest.generations.find(
      (entry) =>
        entry.checkpointId === requestedCheckpointId &&
        entry.attemptId === requestedAttemptId &&
        entry.checksum === requestedChecksum
    );
    if (!generation) return error("Checkpoint confirmation was not found", 404);
    const recordResult = await verifyCheckpointRecord(storage, generation);
    if (!recordResult.ok) {
      return checkpointErrorResponse(recordResult.error, requestedCheckpointId, requestedAttemptId);
    }
    const payloadResult = await verifyPayload(storage, sessionId, generation);
    if (!payloadResult.ok) {
      return checkpointErrorResponse(
        payloadResult.error,
        requestedCheckpointId,
        requestedAttemptId
      );
    }
    if (!recordResult.value || !payloadResult.value) {
      return error("Checkpoint confirmation was not found", 404);
    }
    return json({
      status: "confirmed",
      checkpointId: requestedCheckpointId,
      attemptId: requestedAttemptId,
      checksum: requestedChecksum,
    });
  }
  let validGeneration = 0;
  for (const [manifestIndex, generation] of manifest.generations.entries()) {
    const recordResult = await verifyCheckpointRecord(storage, generation);
    if (!recordResult.ok) {
      return checkpointErrorResponse(recordResult.error, "unknown", "unknown");
    }
    if (!recordResult.value) continue;
    const payloadResult = await verifyPayload(storage, sessionId, generation);
    if (!payloadResult.ok) {
      return checkpointErrorResponse(payloadResult.error, "unknown", "unknown");
    }
    const bytes = payloadResult.value;
    if (!bytes) continue;
    if (validGeneration++ !== requestedGeneration) continue;

    const recovery = manifestIndex === 0 && requestedGeneration === 0 ? "restored" : "fallback";
    return new Response(bytes, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Checkpoint-ID": generation.checkpointId,
        "X-Checkpoint-Recovery": recovery,
        "X-Checkpoint-SHA256": generation.checksum,
        "X-OpenCode-Session-ID": generation.opencodeSessionId,
        "X-OpenCode-Version": generation.opencodeVersion,
        ...(manifest.generations.length > requestedGeneration + 1
          ? { "X-Checkpoint-Next-Generation": String(requestedGeneration + 1) }
          : {}),
      },
    });
  }

  return error("No valid OpenCode checkpoint is available", 404);
}

export const sessionCheckpointRoutes: Route[] = [
  {
    method: "PUT",
    pattern: parsePattern("/sessions/:id/checkpoint"),
    handler: handleCheckpointUpload,
  },
  {
    method: "GET",
    pattern: parsePattern("/sessions/:id/checkpoint"),
    handler: handleCheckpointDownload,
  },
];
