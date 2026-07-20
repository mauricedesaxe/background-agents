import { mediaArtifactIdSchema } from "@open-inspect/shared";
import { createLogger } from "../logger";
import { isSupportedScreenshotMimeType, isSupportedVideoMimeType } from "../media";
import { createMediaObjectStorage } from "../storage/object-storage";
import type { ArtifactResponse, Env } from "../types";
import { getSessionArtifactFromRuntime } from "./session-media-artifacts";
import { error, parsePattern, type Route } from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";

const logger = createLogger("router:session-media");

function getMediaMimeType(
  artifact: Pick<ArtifactResponse, "metadata">
): "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml" | "video/mp4" | null {
  const mimeType = artifact.metadata?.mimeType;
  if (typeof mimeType !== "string") return null;
  if (isSupportedScreenshotMimeType(mimeType) || isSupportedVideoMimeType(mimeType)) {
    return mimeType;
  }
  return null;
}

function getContentTypeFromHeaders(
  headers: Headers
): "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml" | "video/mp4" | null {
  const contentType = headers.get("Content-Type");
  if (!contentType) return null;
  if (isSupportedScreenshotMimeType(contentType) || isSupportedVideoMimeType(contentType)) {
    return contentType;
  }
  return null;
}

// SVG can carry inline <script>. It's rendered via <img> in the UI (which never executes
// script), but be defensive in case the media URL is opened directly: lock the document
// down with a restrictive CSP + sandbox and disable MIME sniffing.
function applySvgSecurityHeaders(headers: Headers, contentType: string): void {
  if (contentType !== "image/svg+xml") return;
  headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  headers.set("X-Content-Type-Options", "nosniff");
}

async function handleMediaGet(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  const artifactId = match.groups?.artifactId;
  if (!sessionId || !artifactId) {
    return error("Session ID and artifact ID are required", 400);
  }
  const storage = createMediaObjectStorage(env);
  if (!mediaArtifactIdSchema.safeParse(artifactId).success) {
    return error("Invalid artifact ID", 400);
  }

  const artifact = await getSessionArtifactFromRuntime(sessionId, artifactId, ctx);
  if (artifact instanceof Response) return artifact;
  if (!artifact || (artifact.type !== "screenshot" && artifact.type !== "video") || !artifact.url) {
    return error("Media artifact not found", 404);
  }

  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    const head = await storage.head(artifact.url);
    if (!head) {
      logger.warn("media.stream.object_missing", {
        session_id: sessionId,
        artifact_id: artifactId,
        object_key: artifact.url,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return error("Media artifact not found", 404);
    }

    const parsedRange = parseByteRangeHeader(rangeHeader, head.size);
    if (parsedRange instanceof Response) return parsedRange;

    const rangedObject = await storage.get(artifact.url, {
      range: { offset: parsedRange.start, length: parsedRange.length },
    });
    if (!rangedObject) {
      return error("Media artifact not found", 404);
    }

    const headers = new Headers();
    head.writeHttpMetadata(headers);
    const contentType = getContentTypeFromHeaders(headers) ?? getMediaMimeType(artifact);
    if (!contentType) {
      logger.error("media.stream.invalid_metadata", {
        session_id: sessionId,
        artifact_id: artifactId,
        object_key: artifact.url,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return error("Media artifact is invalid", 500);
    }

    headers.set("Content-Type", contentType);
    applySvgSecurityHeaders(headers, contentType);
    headers.set("ETag", head.httpEtag);
    headers.set("Accept-Ranges", "bytes");
    headers.set("Content-Range", `bytes ${parsedRange.start}-${parsedRange.end}/${head.size}`);
    headers.set("Content-Length", String(parsedRange.length));

    return new Response(rangedObject.body, { status: 206, headers });
  }

  const object = await storage.get(artifact.url);
  if (!object) {
    logger.warn("media.stream.object_missing", {
      session_id: sessionId,
      artifact_id: artifactId,
      object_key: artifact.url,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Media artifact not found", 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  const contentType = getContentTypeFromHeaders(headers) ?? getMediaMimeType(artifact);
  if (!contentType) {
    logger.error("media.stream.invalid_metadata", {
      session_id: sessionId,
      artifact_id: artifactId,
      object_key: artifact.url,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Media artifact is invalid", 500);
  }

  headers.set("Content-Type", contentType);
  applySvgSecurityHeaders(headers, contentType);
  headers.set("ETag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Length", String(object.size));

  return new Response(object.body, { headers });
}

function parseByteRangeHeader(
  rangeHeader: string,
  size: number
): { start: number; end: number; length: number } | Response {
  const unsatisfied = () =>
    Response.json(
      { error: "Requested range is not satisfiable" },
      { status: 416, headers: { "Content-Range": `bytes */${size}` } }
    );

  if (!rangeHeader.startsWith("bytes=") || rangeHeader.includes(",")) {
    return unsatisfied();
  }

  const range = rangeHeader.slice("bytes=".length).trim();
  const parts = range.split("-");
  if (parts.length !== 2) {
    return unsatisfied();
  }
  const [startRaw, endRaw] = parts;

  let start: number;
  let end: number;
  if (startRaw === "") {
    const suffixLength = Number(endRaw);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return unsatisfied();
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === "" ? size - 1 : Number(endRaw);
  }

  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return unsatisfied();
  }

  end = Math.min(end, size - 1);
  return { start, end, length: end - start + 1 };
}

export const sessionMediaStreamRoutes: Route[] = [
  sessionRoute({
    method: "GET",
    pattern: parsePattern("/sessions/:id/media/:artifactId"),
    handler: handleMediaGet,
  }),
];
