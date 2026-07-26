import assert from "node:assert/strict";
import test from "node:test";
import {
  captureBoardInspection,
  parseBoardArgs,
  runBoardCommand,
} from "../src/sandbox_runtime/bin/board.js";

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
    output: undefined,
  });
});

test("parseBoardArgs requires a boardId for mutate and snapshot", () => {
  assert.throws(() => parseBoardArgs(["mutate"]), /requires a <boardId>/);
  assert.throws(() => parseBoardArgs(["snapshot"]), /requires a <boardId>/);
});

test("parseBoardArgs parses inspect with an output path", () => {
  assert.deepEqual(parseBoardArgs(["inspect", "board-9", "--output", "/tmp/board.png"]), {
    command: "inspect",
    boardId: "board-9",
    title: undefined,
    file: undefined,
    output: "/tmp/board.png",
  });
});

test("parseBoardArgs requires an output path for inspect", () => {
  assert.throws(() => parseBoardArgs(["inspect", "board-9"]), /requires --output/);
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

test("inspect acquires a URL and captures its explicit ready state", async () => {
  const { bridgeFetch, calls } = recordingFetch(
    fakeResponse({ body: '{"url":"https://web.test/board/inspect/s1/b1#token=secret"}' })
  );
  const captures = [];

  const out = await runBoardCommand({
    argv: ["inspect", "b1", "--output", "/tmp/board.png"],
    bridgeFetch,
    captureInspection: async (options) => {
      captures.push(options);
      return { width: 1440, height: 900 };
    },
  });

  assert.equal(calls[0].path, "/board/b1/inspect");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(captures, [
    {
      url: "https://web.test/board/inspect/s1/b1#token=secret",
      output: "/tmp/board.png",
    },
  ]);
  assert.equal(out, "Saved /tmp/board.png (1440x900)");
});

test("inspect surfaces URL acquisition and rendered page failures", async () => {
  const { bridgeFetch } = recordingFetch(
    fakeResponse({ ok: false, status: 404, body: '{"error":"Board not found"}' })
  );
  await assert.rejects(
    runBoardCommand({
      argv: ["inspect", "missing", "--output", "/tmp/board.png"],
      bridgeFetch,
    }),
    /Board inspect failed: Board not found/
  );

  const successfulFetch = recordingFetch(
    fakeResponse({ body: '{"url":"https://web.test/board/inspect/s1/b1#token=secret"}' })
  );
  await assert.rejects(
    runBoardCommand({
      argv: ["inspect", "b1", "--output", "/tmp/board.png"],
      bridgeFetch: successfulFetch.bridgeFetch,
      captureInspection: async () => {
        throw new Error("Board render timed out");
      },
    }),
    /Board render timed out/
  );
});

test("captureBoardInspection fixes the viewport before navigation and waits for readiness", async () => {
  const calls = [];
  const executeBrowser = async (args) => {
    calls.push(args.slice(2));
    if (args[2] === "get") return "ready";
    return "";
  };
  const png = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png);
  png.writeUInt32BE(1440, 16);
  png.writeUInt32BE(900, 20);

  const result = await captureBoardInspection({
    url: "https://web.test/board#token=secret",
    output: "/tmp/board.png",
    executeBrowser,
    readOutput: async () => png,
  });

  assert.deepEqual(calls.slice(0, 5), [
    ["set", "viewport", "1440", "900"],
    ["open", "https://web.test/board#token=secret"],
    ["wait", "[data-board-inspection-state]"],
    ["get", "attr", "[data-board-inspection-state]", "data-board-inspection-state"],
    ["screenshot", "/tmp/board.png", "--json"],
  ]);
  assert.deepEqual(result, { width: 1440, height: 900 });
  assert.deepEqual(calls.at(-1), ["close"]);
});

test("captureBoardInspection returns the page error and always closes the browser", async () => {
  const calls = [];
  const executeBrowser = async (args) => {
    calls.push(args.slice(2));
    if (args[2] !== "get") return "";
    return args.at(-1) === "data-board-inspection-state" ? "error" : "Board sync failed";
  };

  await assert.rejects(
    captureBoardInspection({
      url: "https://web.test/board#token=secret",
      output: "/tmp/board.png",
      executeBrowser,
    }),
    /Board sync failed/
  );
  assert.deepEqual(calls.at(-1), ["close"]);
});

test("captureBoardInspection rejects invalid screenshot output", async () => {
  const executeBrowser = async (args) => (args[2] === "get" ? "ready" : "");

  await assert.rejects(
    captureBoardInspection({
      url: "https://web.test/board#token=secret",
      output: "/tmp/board.png",
      executeBrowser,
      readOutput: async () => Buffer.from("not a png"),
    }),
    /did not produce a valid PNG/
  );
});
