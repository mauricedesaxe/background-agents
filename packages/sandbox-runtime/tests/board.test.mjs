import assert from "node:assert/strict";
import test from "node:test";
import { parseBoardArgs, runBoardCommand } from "../src/sandbox_runtime/bin/board.js";

function fakeResponse({ ok = true, status = 200, body = "" }) {
  return { ok, status, text: async () => body };
}

/** Records each bridgeFetch call and returns a scripted response. */
function recordingFetch(response) {
  const calls = [];
  const bridgeFetch = async (path, options = {}) => {
    calls.push({ path, options });
    return response;
  };
  return { bridgeFetch, calls };
}

test("parseBoardArgs parses create with a title", () => {
  assert.deepEqual(parseBoardArgs(["create", "--title", "System design"]), {
    command: "create",
    boardId: undefined,
    title: "System design",
    file: undefined,
  });
});

test("parseBoardArgs requires a boardId for mutate and snapshot", () => {
  assert.throws(() => parseBoardArgs(["mutate"]), /requires a <boardId>/);
  assert.throws(() => parseBoardArgs(["snapshot"]), /requires a <boardId>/);
});

test("parseBoardArgs rejects an unknown command", () => {
  assert.throws(() => parseBoardArgs(["frobnicate"]), /Usage: board/);
});

test("create posts to /board with the title", async () => {
  const { bridgeFetch, calls } = recordingFetch(fakeResponse({ body: '{"boardId":"b1"}' }));
  const out = await runBoardCommand({ argv: ["create", "--title", "Arch"], bridgeFetch });
  assert.equal(calls[0].path, "/board");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), { title: "Arch" });
  assert.equal(out, '{"boardId":"b1"}');
});

test("mutate posts the payload from readPayload to the board mutate path", async () => {
  const { bridgeFetch, calls } = recordingFetch(fakeResponse({ body: '{"applied":2}' }));
  const payload = '{"create":[],"update":[],"delete":[]}';
  await runBoardCommand({
    argv: ["mutate", "board-9"],
    bridgeFetch,
    readPayload: async () => payload,
  });
  assert.equal(calls[0].path, "/board/board-9/mutate");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.body, payload);
});

test("snapshot reads the board snapshot path", async () => {
  const { bridgeFetch, calls } = recordingFetch(fakeResponse({ body: '{"documents":[]}' }));
  const out = await runBoardCommand({ argv: ["snapshot", "board-9"], bridgeFetch });
  assert.equal(calls[0].path, "/board/board-9/snapshot");
  assert.equal(out, '{"documents":[]}');
});

test("snapshot throws on a non-2xx response instead of returning an empty document", async () => {
  const { bridgeFetch } = recordingFetch(
    fakeResponse({ ok: false, status: 500, body: '{"error":"Board room unavailable"}' })
  );
  await assert.rejects(
    runBoardCommand({ argv: ["snapshot", "board-9"], bridgeFetch }),
    /Board snapshot failed: Board room unavailable/
  );
});

test("create surfaces a failure error from the server", async () => {
  const { bridgeFetch } = recordingFetch(
    fakeResponse({ ok: false, status: 500, body: '{"error":"No sandbox"}' })
  );
  await assert.rejects(
    runBoardCommand({ argv: ["create", "--title", "x"], bridgeFetch }),
    /Board create failed: No sandbox/
  );
});

test("mutate surfaces a rejection error from the server", async () => {
  const { bridgeFetch } = recordingFetch(
    fakeResponse({ ok: false, status: 400, body: '{"error":"Mutation rejected by board schema"}' })
  );
  await assert.rejects(
    runBoardCommand({
      argv: ["mutate", "board-9"],
      bridgeFetch,
      readPayload: async () => "{}",
    }),
    /Board mutate failed: Mutation rejected by board schema/
  );
});
