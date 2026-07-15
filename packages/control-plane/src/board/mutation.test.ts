import { describe, expect, it } from "vitest";
import type { TLRecord } from "@tldraw/tlschema";
import type { RoomStoreMethods } from "@tldraw/sync-core";
import { applyBoardMutation, boardMutateRequestSchema } from "./mutation";

/**
 * Structural stand-in for a tldraw record. The real `TLRecord` union has no index
 * signature, so it can't satisfy the schema's passthrough element type; this
 * mirror does, and is what the mutate payload accepts anyway.
 */
type TestRecord = { id: string; typeName: string; [k: string]: unknown };

/** Minimal in-memory RoomStoreMethods for exercising applyBoardMutation. */
function fakeStore(initial: Record<string, TestRecord> = {}) {
  const records = new Map<string, TestRecord>(Object.entries(initial));
  const store = {
    put(record: TestRecord) {
      records.set(record.id, record);
    },
    delete(recordOrId: TestRecord | string) {
      records.delete(typeof recordOrId === "string" ? recordOrId : recordOrId.id);
    },
    get(id: string) {
      return records.get(id) ?? null;
    },
    getAll() {
      return [...records.values()];
    },
  } as unknown as RoomStoreMethods<TLRecord>;
  return { store, records };
}

function shape(id: string, extra: Record<string, unknown> = {}): TestRecord {
  return { id, typeName: "shape", type: "geo", x: 0, y: 0, ...extra };
}

describe("boardMutateRequestSchema", () => {
  it("defaults all three verbs to empty arrays", () => {
    const parsed = boardMutateRequestSchema.parse({});
    expect(parsed).toEqual({ create: [], update: [], delete: [] });
  });

  it("accepts a well-formed payload", () => {
    const parsed = boardMutateRequestSchema.safeParse({
      create: [{ id: "shape:a", typeName: "shape", type: "geo" }],
      update: [{ id: "shape:b", changes: { x: 10 } }],
      delete: ["shape:c"],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a create record missing id/typeName", () => {
    const parsed = boardMutateRequestSchema.safeParse({ create: [{ type: "geo" }] });
    expect(parsed.success).toBe(false);
  });

  it("rejects an update patch missing changes", () => {
    const parsed = boardMutateRequestSchema.safeParse({ update: [{ id: "shape:a" }] });
    expect(parsed.success).toBe(false);
  });
});

describe("applyBoardMutation", () => {
  it("creates records and reports counts", () => {
    const { store, records } = fakeStore();
    const result = applyBoardMutation(store, {
      create: [shape("shape:a"), shape("shape:b")],
      update: [],
      delete: [],
    });
    expect(result).toEqual({ applied: 2, created: 2, updated: 0, deleted: 0 });
    expect(records.size).toBe(2);
  });

  it("merges an update onto the current record without clobbering other fields", () => {
    const { store, records } = fakeStore({ "shape:a": shape("shape:a", { x: 5, y: 7 }) });
    // Agent changes only x; a concurrent human move set y to 7 — it must survive.
    const result = applyBoardMutation(store, {
      create: [],
      update: [{ id: "shape:a", changes: { x: 99 } }],
      delete: [],
    });
    expect(result.updated).toBe(1);
    expect(records.get("shape:a")).toMatchObject({ id: "shape:a", x: 99, y: 7 });
  });

  it("never overwrites id or typeName from a patch", () => {
    const { store, records } = fakeStore({ "shape:a": shape("shape:a") });
    applyBoardMutation(store, {
      create: [],
      update: [{ id: "shape:a", changes: { id: "shape:evil", typeName: "binding" } }],
      delete: [],
    });
    expect(records.get("shape:a")).toMatchObject({ id: "shape:a", typeName: "shape" });
    expect(records.has("shape:evil")).toBe(false);
  });

  it("skips (does not count) an update to a record that no longer exists", () => {
    const { store } = fakeStore();
    const result = applyBoardMutation(store, {
      create: [],
      update: [{ id: "shape:gone", changes: { x: 1 } }],
      delete: [],
    });
    expect(result.updated).toBe(0);
    expect(result.applied).toBe(0);
  });

  it("deletes records", () => {
    const { store, records } = fakeStore({ "shape:a": shape("shape:a") });
    const result = applyBoardMutation(store, { create: [], update: [], delete: ["shape:a"] });
    expect(result.deleted).toBe(1);
    expect(records.has("shape:a")).toBe(false);
  });

  it("does not count a delete of a record that no longer exists", () => {
    const { store } = fakeStore();
    const result = applyBoardMutation(store, { create: [], update: [], delete: ["shape:gone"] });
    expect(result.deleted).toBe(0);
    expect(result.applied).toBe(0);
  });

  it("treats an empty batch as a no-op", () => {
    const { store } = fakeStore();
    const result = applyBoardMutation(store, { create: [], update: [], delete: [] });
    expect(result.applied).toBe(0);
  });
});
