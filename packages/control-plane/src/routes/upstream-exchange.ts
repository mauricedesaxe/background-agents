import { upstreamExchangeRequestSchema, type UpstreamExchangeRequest } from "@open-inspect/shared";
import {
  UpstreamExchangeConflictError,
  UpstreamExchangeStore,
} from "../db/upstream-exchange-store";
import { SessionIndexStore } from "../db/session-index";
import type { Env } from "../types";
import { error, json, parsePattern, type RequestContext, type Route } from "./shared";

async function handleUpstreamExchange(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required", 400);

  const session = await new SessionIndexStore(ctx.db).get(sessionId);
  if (
    !session ||
    session.spawnSource !== "automation" ||
    !session.automationId ||
    !session.automationRunId
  ) {
    return error("Upstream exchange is available only to automation runs", 403);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return error("Body must be valid JSON", 400);
  }
  const parsed = upstreamExchangeRequestSchema.safeParse(raw);
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Invalid request", 400);

  const store = new UpstreamExchangeStore(ctx.db);
  try {
    return await executeRequest(store, session.automationId, session.automationRunId, parsed.data);
  } catch (cause) {
    if (cause instanceof UpstreamExchangeConflictError) return error(cause.message, 409);
    throw cause;
  }
}

async function executeRequest(
  store: UpstreamExchangeStore,
  automationId: string,
  automationRunId: string,
  request: UpstreamExchangeRequest
): Promise<Response> {
  if (request.action === "cursor") {
    const cursor = await store.getCursor(automationId, request.direction, request.sourceRepository);
    return json({ ok: true, cursor });
  }

  if (request.action === "begin") {
    if (new Set(request.expectedCommitShas).size !== request.expectedCommitShas.length) {
      return error("expectedCommitShas must not contain duplicates", 400);
    }
    const scan = await store.beginScan({
      id: crypto.randomUUID(),
      automationId,
      automationRunId,
      direction: request.direction,
      sourceRepository: request.sourceRepository,
      fromSha: request.fromSha,
      toSha: request.toSha,
      forkHeadSha: request.forkHeadSha,
      upstreamHeadSha: request.upstreamHeadSha,
      mergeBaseSha: request.mergeBaseSha,
      expectedCommitShas: request.expectedCommitShas,
    });
    return json({
      ok: true,
      scanId: scan.id,
      resumed: scan.resumed,
      classifiedCommitShas: scan.classifiedCommitShas,
    });
  }

  const result = await store.recordDisposition({
    scanId: request.scanId,
    automationId,
    automationRunId,
    commitSha: request.commitSha,
    disposition: {
      classification: request.classification,
      evidence: request.evidence,
      affectedPackages: request.affectedPackages,
      terraformImpact: request.terraformImpact,
      migrationImpact: request.migrationImpact,
      divergenceEntries: request.divergenceEntries,
      testHandMerge: request.testHandMerge,
      semanticPortEvidence: request.semanticPortEvidence,
      usefulUnit: request.usefulUnit,
      proposedArtifact: request.proposedArtifact,
    },
  });
  return json({ ok: true, repeated: result.repeated });
}

export const upstreamExchangeRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/sessions/:id/upstream-exchange"),
    handler: handleUpstreamExchange,
  },
];
