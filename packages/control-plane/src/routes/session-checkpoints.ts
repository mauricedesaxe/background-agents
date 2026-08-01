import { z } from "zod";
import { createMediaObjectStorage, type ObjectStorage } from "../storage/object-storage";
import type { Env } from "../types";
import { error, json, parsePattern, type Route } from "./shared";

const CHECKPOINT_MAX_BYTES = 50 * 1024 * 1024;
const CHECKPOINT_GENERATIONS_TO_KEEP = 2;
const CHECKPOINT_SCHEMA_VERSION = 1;

const checkpointGenerationSchema = z.object({
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().positive(),
  opencodeSessionId: z.string().min(1),
  opencodeVersion: z.string().min(1),
});

const checkpointManifestSchema = z.object({
  schemaVersion: z.literal(CHECKPOINT_SCHEMA_VERSION),
  generations: z.array(checkpointGenerationSchema).max(CHECKPOINT_GENERATIONS_TO_KEEP),
});

type CheckpointGeneration = z.infer<typeof checkpointGenerationSchema>;
type CheckpointManifest = z.infer<typeof checkpointManifestSchema>;

function checkpointPrefix(sessionId: string): string {
  return `sessions/${sessionId}/checkpoints`;
}

function manifestKey(sessionId: string): string {
  return `${checkpointPrefix(sessionId)}/latest.json`;
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

async function readManifest(
  storage: ObjectStorage,
  sessionId: string
): Promise<CheckpointManifest> {
  const object = await storage.get(manifestKey(sessionId));
  if (!object) return { schemaVersion: CHECKPOINT_SCHEMA_VERSION, generations: [] };
  try {
    const parsed = JSON.parse(await new Response(object.body).text());
    const result = checkpointManifestSchema.safeParse(parsed);
    return result.success
      ? result.data
      : { schemaVersion: CHECKPOINT_SCHEMA_VERSION, generations: [] };
  } catch {
    return { schemaVersion: CHECKPOINT_SCHEMA_VERSION, generations: [] };
  }
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
  if (!opencodeSessionId || !opencodeVersion) {
    return error("OpenCode session ID and version are required", 400);
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
  const checksum = await sha256(bytes);
  const objectKey = generationKey(sessionId, checksum);
  await storage.put(objectKey, bytes, { contentType: "application/json" });
  if (!(await storage.head(objectKey))) {
    return error("Checkpoint generation could not be verified", 503);
  }

  const previous = await readManifest(storage, sessionId);
  const generation: CheckpointGeneration = {
    checksum,
    byteLength: bytes.byteLength,
    opencodeSessionId,
    opencodeVersion,
  };
  const generations = [
    generation,
    ...previous.generations.filter((entry) => entry.checksum !== checksum),
  ].slice(0, CHECKPOINT_GENERATIONS_TO_KEEP);
  await storage.put(
    manifestKey(sessionId),
    JSON.stringify({ schemaVersion: CHECKPOINT_SCHEMA_VERSION, generations }),
    { contentType: "application/json" }
  );
  const retainedChecksums = new Set(generations.map((entry) => entry.checksum));
  await Promise.all(
    previous.generations
      .filter((entry) => !retainedChecksums.has(entry.checksum))
      .map((entry) => storage.delete(generationKey(sessionId, entry.checksum)))
  );

  return json({ checksum }, 201);
}

async function handleCheckpointDownload(
  request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");
  const requestedGeneration = Number(new URL(request.url).searchParams.get("generation") ?? 0);
  if (
    !Number.isInteger(requestedGeneration) ||
    requestedGeneration < 0 ||
    requestedGeneration >= CHECKPOINT_GENERATIONS_TO_KEEP
  ) {
    return error("Checkpoint generation is invalid", 400);
  }

  const storage = createMediaObjectStorage(env);
  const manifest = await readManifest(storage, sessionId);
  let validGeneration = 0;
  for (const generation of manifest.generations) {
    const object = await storage.get(generationKey(sessionId, generation.checksum));
    if (!object || object.size !== generation.byteLength) continue;
    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    if ((await sha256(bytes)) !== generation.checksum) continue;
    if (validGeneration++ !== requestedGeneration) continue;

    return new Response(bytes, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Checkpoint-SHA256": generation.checksum,
        "X-OpenCode-Session-ID": generation.opencodeSessionId,
        "X-OpenCode-Version": generation.opencodeVersion,
        "X-Checkpoint-Generation": String(requestedGeneration),
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
