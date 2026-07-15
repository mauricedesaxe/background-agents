import { describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { BoardInternalPaths } from "../../src/board/contracts";

/**
 * Exercises the BoardRoom Durable Object directly (the worker board routes just
 * forward to it). Proves the tldraw `TLSocketRoom` boots under workerd, persists
 * to DO SQLite, and that the agent's mutate/snapshot endpoints behave — including
 * the load-bearing all-or-nothing rejection of a batch containing an invalid
 * record. Uses `page` records: document-scoped, few required props, so the test
 * pins room mechanics without hand-authoring complex geo/arrow schemas.
 */

let counter = 0;
function boardStub() {
  counter += 1;
  const boardId = `board-${counter}`;
  return env.BOARD_ROOM.get(env.BOARD_ROOM.idFromName(boardId));
}

function page(id: string, name: string, index = "a2") {
  return { id, typeName: "page", name, index, meta: {} };
}

async function mutate(stub: DurableObjectStub, body: unknown): Promise<Response> {
  return stub.fetch(`http://board${BoardInternalPaths.mutate}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function snapshotIds(stub: DurableObjectStub): Promise<string[]> {
  const res = await stub.fetch(`http://board${BoardInternalPaths.snapshot}`);
  expect(res.status).toBe(200);
  const snapshot = (await res.json()) as { documents: { state: { id: string } }[] };
  return snapshot.documents.map((d) => d.state.id);
}

describe("BoardRoom (integration)", () => {
  it("boots the room and returns an empty document's baseline records", async () => {
    const stub = boardStub();
    const res = await stub.fetch(`http://board${BoardInternalPaths.snapshot}`);
    expect(res.status).toBe(200);
    const snapshot = (await res.json()) as { documents: unknown[] };
    // A fresh room still has its baseline document + default page records.
    expect(Array.isArray(snapshot.documents)).toBe(true);
  });

  it("treats an empty mutation as a no-op", async () => {
    const stub = boardStub();
    const res = await mutate(stub, { create: [], update: [], delete: [] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: 0 });
  });

  it("creates a record and reflects it in the snapshot", async () => {
    const stub = boardStub();
    const res = await mutate(stub, { create: [page("page:created", "Created")] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: 1, applied: 1 });
    expect(await snapshotIds(stub)).toContain("page:created");
  });

  it("merges an update onto the current record", async () => {
    const stub = boardStub();
    await mutate(stub, { create: [page("page:x", "Original")] });
    const res = await mutate(stub, { update: [{ id: "page:x", changes: { name: "Renamed" } }] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ updated: 1 });

    const snap = (await (
      await stub.fetch(`http://board${BoardInternalPaths.snapshot}`)
    ).json()) as { documents: { state: { id: string; name?: string } }[] };
    const record = snap.documents.find((d) => d.state.id === "page:x");
    expect(record?.state.name).toBe("Renamed");
  });

  it("deletes a record", async () => {
    const stub = boardStub();
    await mutate(stub, { create: [page("page:doomed", "Doomed")] });
    const res = await mutate(stub, { delete: ["page:doomed"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deleted: 1 });
    expect(await snapshotIds(stub)).not.toContain("page:doomed");
  });

  it("rejects a payload that fails envelope validation", async () => {
    const stub = boardStub();
    // A create entry with no id/typeName fails the zod envelope.
    const res = await mutate(stub, { create: [{ name: "no id" }] });
    expect(res.status).toBe(400);
  });

  it("rejects a mixed batch atomically — nothing in it is applied", async () => {
    const stub = boardStub();
    // One valid page, one page missing its required `name` (schema-invalid).
    const res = await mutate(stub, {
      create: [
        page("page:good", "Good"),
        { id: "page:bad", typeName: "page", index: "a3", meta: {} },
      ],
    });
    expect(res.status).toBe(400);
    // The transaction did not commit: the valid record must be absent too.
    expect(await snapshotIds(stub)).not.toContain("page:good");
  });

  it("rejects a browser connect with no sessionId", async () => {
    const stub = boardStub();
    const res = await stub.fetch("http://board/connect", {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(400);
  });
});

describe("board WebSocket auth hop (integration)", () => {
  // Exercises handleBoardWebSocket in index.ts: the worker verifies the browser's
  // ws-token against the session DO before forwarding the upgrade to BoardRoom.
  // The 401 branches are the security-critical ones — an unauthenticated socket
  // must never reach a board room.
  it("rejects a board WS with no token", async () => {
    const res = await SELF.fetch("https://example.com/sessions/s-noauth/board/b1/ws", {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a board WS whose token matches no participant", async () => {
    const res = await SELF.fetch(
      "https://example.com/sessions/s-noauth/board/b1/ws?token=bogus-token",
      { headers: { Upgrade: "websocket" } }
    );
    expect(res.status).toBe(401);
  });
});
