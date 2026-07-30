import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { bridgeFetch, extractError } from "./_bridge-client.js";

const shaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const successResponseSchema = z.union([
  z.object({ ok: z.literal(true), cursor: shaSchema.nullable() }),
  z.object({
    ok: z.literal(true),
    scanId: z.string().uuid(),
    resumed: z.boolean(),
    classifiedCommitShas: z.array(shaSchema),
  }),
  z.object({ ok: z.literal(true), repeated: z.boolean() }),
]);

export default tool({
  name: "upstream-exchange",
  description:
    "Read and update the durable commit ledger for a scheduled tracked-fork exchange report. This tool works only in automation sessions. Call cursor before examining a range, begin once the exact commit list and heads are known, classify only expected commits absent from begin's classifiedCommitShas, then pass the returned scanId to slack-notify. It never writes to GitHub.",
  args: {
    action: z.enum(["cursor", "begin", "classify"]),
    direction: z.enum(["outbound", "inbound"]).optional(),
    sourceRepository: z.string().optional(),
    fromSha: z.string().nullable().optional(),
    toSha: z.string().optional(),
    forkHeadSha: z.string().optional(),
    upstreamHeadSha: z.string().optional(),
    mergeBaseSha: z.string().optional(),
    expectedCommitShas: z.array(z.string()).optional(),
    scanId: z.string().uuid().optional(),
    commitSha: z.string().optional(),
    classification: z
      .enum([
        "candidate",
        "intentional_divergence",
        "deployment_specific",
        "already_upstream",
        "not_useful_upstream",
        "present",
        "not_applicable",
        "divergence_conflict",
        "clean_candidate",
        "needs_decision",
      ])
      .optional(),
    evidence: z.string().optional(),
    affectedPackages: z.array(z.string()).optional(),
    terraformImpact: z.string().optional(),
    migrationImpact: z.string().optional(),
    divergenceEntries: z.array(z.string()).optional(),
    testHandMerge: z.boolean().optional(),
    semanticPortEvidence: z.string().optional(),
    usefulUnit: z.enum(["idea", "bug_report", "test_case", "implementation"]).nullable().optional(),
    proposedArtifact: z.string().nullable().optional(),
  },
  async execute(args) {
    let response;
    try {
      response = await bridgeFetch("/upstream-exchange", {
        method: "POST",
        body: JSON.stringify(args),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return JSON.stringify({ ok: false, error: message });
    }

    if (!response.ok) {
      return JSON.stringify({ ok: false, error: await extractError(response) });
    }
    try {
      const parsed = successResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        return JSON.stringify({ ok: false, error: "Invalid control-plane response" });
      }
      return JSON.stringify(parsed.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return JSON.stringify({ ok: false, error: `Invalid control-plane response: ${message}` });
    }
  },
});
