import { z } from "zod";
import type { TLRecord } from "@tldraw/tlschema";
import type { RoomStoreMethods } from "@tldraw/sync-core";

/**
 * A tldraw record envelope. Only `id` and `typeName` are checked here; the room
 * schema is the authoritative validator when the record is `put` into the store.
 */
const recordEnvelopeSchema = z
  .object({ id: z.string().min(1), typeName: z.string().min(1) })
  .passthrough();

/**
 * The agent's board mutation payload. The three verbs are deliberately distinct:
 *
 * - `create` carries whole records authored from scratch (shapes, bindings).
 * - `update` carries partial patches that are merged onto the *current* record
 *   inside the room transaction, so a human's concurrent move of the same shape
 *   is not clobbered by an agent editing an unrelated field.
 * - `delete` carries record ids.
 *
 * An empty payload is a legitimate no-op (`applied: 0`), not an error.
 */
export const boardMutateRequestSchema = z.object({
  create: z.array(recordEnvelopeSchema).default([]),
  update: z
    .array(z.object({ id: z.string().min(1), changes: z.record(z.string(), z.unknown()) }))
    .default([]),
  delete: z.array(z.string().min(1)).default([]),
});

export type BoardMutateRequest = z.infer<typeof boardMutateRequestSchema>;

export interface BoardMutateResult {
  applied: number;
  created: number;
  updated: number;
  deleted: number;
}

/**
 * Apply a parsed mutation to a room store. Runs inside `room.updateStore`, which
 * the tldraw sync engine executes as a single transaction: if a `put` is
 * rejected by the room schema it throws, the transaction does not commit, and
 * nothing in the batch is applied (all-or-nothing). `update` reads the current
 * record and shallow-merges the patch so concurrent edits to fields outside the
 * patch survive; `id` and `typeName` are never overwritten.
 */
export function applyBoardMutation(
  store: RoomStoreMethods<TLRecord>,
  request: BoardMutateRequest
): BoardMutateResult {
  // Count only records that actually existed, so `deleted` reflects effect, not
  // intent — symmetric with `update`, which skips a patch to a gone record.
  // Deleting an already-absent record is not an error: the intended end state
  // (that record absent) already holds.
  let deleted = 0;
  for (const id of request.delete) {
    if (store.get(id) === null) continue;
    store.delete(id);
    deleted += 1;
  }

  let updated = 0;
  for (const patch of request.update) {
    const current = store.get(patch.id);
    // Skip patches to records that no longer exist (a human may have deleted the
    // shape between the agent's read and this write). Not an error: the intended
    // end state — that record absent — already holds.
    if (!current) continue;
    // Merge the patch onto the live record, preserving identity. The spread
    // widens the id union past what TS can re-narrow to TLRecord, so cast at the
    // boundary; the room schema validates the result on put.
    store.put({
      ...current,
      ...patch.changes,
      id: current.id,
      typeName: current.typeName,
    } as unknown as TLRecord);
    updated += 1;
  }

  for (const record of request.create) {
    store.put(record as unknown as TLRecord);
  }

  return {
    applied: request.create.length + updated + deleted,
    created: request.create.length,
    updated,
    deleted,
  };
}
