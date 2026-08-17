import { readBodyCapped, sha256Hex } from "@open-inspect/shared";
import { error, json, parsePattern, type Route, SCM_AGNOSTIC_SANDBOX_ROUTE } from "./shared";

const LEGACY_CHECKPOINT_MAX_BYTES = 50 * 1024 * 1024;

async function handleLegacyCheckpointUpload(request: Request): Promise<Response> {
  const checkpoint = await readBodyCapped(request.body, LEGACY_CHECKPOINT_MAX_BYTES);
  if (!checkpoint) return error("Legacy checkpoint payload is too large", 413);
  if (checkpoint.byteLength === 0) return error("Legacy checkpoint payload is empty");

  return json({ checksum: await sha256Hex(checkpoint) });
}

async function handleLegacyCheckpointDownload(): Promise<Response> {
  return error("Automatic checkpoint restoration is unavailable", 404);
}

export const sessionLegacyCheckpointRoutes: Route[] = [
  {
    method: "PUT",
    pattern: parsePattern("/sessions/:id/checkpoint"),
    handler: handleLegacyCheckpointUpload,
    ...SCM_AGNOSTIC_SANDBOX_ROUTE,
  },
  {
    method: "GET",
    pattern: parsePattern("/sessions/:id/checkpoint"),
    handler: handleLegacyCheckpointDownload,
    ...SCM_AGNOSTIC_SANDBOX_ROUTE,
  },
];
