import { z } from "zod";

export const upstreamExchangeDirectionSchema = z.enum(["outbound", "inbound"]);
export type UpstreamExchangeDirection = z.infer<typeof upstreamExchangeDirectionSchema>;

export const outboundDispositionSchema = z.enum([
  "candidate",
  "intentional_divergence",
  "deployment_specific",
  "already_upstream",
  "not_useful_upstream",
]);

export const inboundDispositionSchema = z.enum([
  "present",
  "not_applicable",
  "divergence_conflict",
  "clean_candidate",
  "needs_decision",
]);

export const upstreamExchangeClassificationSchema = z.union([
  outboundDispositionSchema,
  inboundDispositionSchema,
]);
export type UpstreamExchangeClassification = z.infer<typeof upstreamExchangeClassificationSchema>;

export const upstreamExchangeUsefulUnitSchema = z.enum([
  "idea",
  "bug_report",
  "test_case",
  "implementation",
]);
export type UpstreamExchangeUsefulUnit = z.infer<typeof upstreamExchangeUsefulUnitSchema>;

const shaSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i, "must be a full Git commit SHA")
  .transform((value) => value.toLowerCase());
const repositorySchema = z
  .string()
  .regex(/^[^/\s]+\/[^/\s]+$/, "must be owner/repository")
  .transform((value) => value.toLowerCase());

const classifyRequestSchema = z
  .object({
    action: z.literal("classify"),
    scanId: z.string().uuid(),
    commitSha: shaSchema,
    classification: upstreamExchangeClassificationSchema,
    evidence: z.string().min(1).max(10_000),
    affectedPackages: z.array(z.string().min(1).max(200)).max(100),
    terraformImpact: z.string().max(5000),
    migrationImpact: z.string().max(5000),
    divergenceEntries: z.array(z.string().min(1).max(500)).max(100),
    testHandMerge: z.boolean(),
    semanticPortEvidence: z.string().min(1).max(10_000),
    usefulUnit: upstreamExchangeUsefulUnitSchema.nullable(),
    proposedArtifact: z.string().min(1).max(5000).nullable(),
  })
  .superRefine((value, ctx) => {
    if ((value.classification === "candidate") !== (value.usefulUnit !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["usefulUnit"],
        message: "must be set only for candidate classifications",
      });
    }
    if (
      outboundDispositionSchema.safeParse(value.classification).success &&
      value.proposedArtifact
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["proposedArtifact"],
        message: "must be null for outbound classifications",
      });
    }
  });

export const upstreamExchangeRequestSchema = z.union([
  z.object({
    action: z.literal("cursor"),
    direction: upstreamExchangeDirectionSchema,
    sourceRepository: repositorySchema,
  }),
  z.object({
    action: z.literal("begin"),
    direction: upstreamExchangeDirectionSchema,
    sourceRepository: repositorySchema,
    fromSha: shaSchema.nullable(),
    toSha: shaSchema,
    forkHeadSha: shaSchema,
    upstreamHeadSha: shaSchema,
    mergeBaseSha: shaSchema,
    expectedCommitShas: z.array(shaSchema).max(2000),
  }),
  classifyRequestSchema,
]);

export type UpstreamExchangeRequest = z.infer<typeof upstreamExchangeRequestSchema>;

export function classificationMatchesDirection(
  direction: UpstreamExchangeDirection,
  classification: UpstreamExchangeClassification
): boolean {
  return direction === "outbound"
    ? outboundDispositionSchema.safeParse(classification).success
    : inboundDispositionSchema.safeParse(classification).success;
}
