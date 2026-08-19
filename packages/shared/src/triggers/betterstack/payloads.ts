import { z } from "zod";

const betterstackIdentifierSchema = z.union([z.string(), z.number()]).transform(String);

/**
 * BetterStack incident webhook body (JSON:API-style `data.attributes` shape).
 * Everything except the incident id is nullish-tolerant: BetterStack lets users
 * customize the outbound payload, so only the id is relied on for identity.
 */
export const betterstackIncidentSchema = z.object({
  data: z.object({
    id: betterstackIdentifierSchema,
    type: z.string().optional(),
    attributes: z.object({
      name: z.string().nullish(),
      url: z.string().nullish(),
      cause: z.string().nullish(),
      started_at: z.string().nullish(),
      acknowledged_at: z.string().nullish(),
      resolved_at: z.string().nullish(),
      status: z.string().nullish(),
    }),
  }),
});

export type BetterstackIncidentPayload = z.infer<typeof betterstackIncidentSchema>;
