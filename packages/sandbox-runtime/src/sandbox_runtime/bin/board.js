#!/usr/bin/env node

/**
 * `board` — drive an interactive tldraw whiteboard from the sandbox.
 *
 * The agent authors tldraw records as JSON and posts them to the control plane;
 * the board document and tldraw runtime stay in the hosted application. The
 * sandbox only drives that renderer through Chromium for inspection. Subcommands:
 *
 *   board create [--title "..."]        -> prints { boardId, ... }
 *   board mutate <boardId> [--file f]   -> applies { create, update, delete }
 *                                          (payload from --file or stdin)
 *   board snapshot <boardId>            -> prints the document snapshot JSON
 *                                          (redirect to a .tldr to save to git)
 *   board inspect <boardId> --output f  -> renders the live board to a PNG
 *
 * Self-contained (bin scripts are copied flat onto PATH, so it can't import the
 * shared bridge client) but factored so the core is unit-testable with an
 * injected fetch.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const COMMANDS = new Set(["create", "mutate", "snapshot", "inspect"]);
const INSPECTION_VIEWPORT = { width: 1440, height: 900 };
const execFileAsync = promisify(execFile);

export function parseBoardArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || !COMMANDS.has(command)) {
    throw new Error(
      `Usage: board <create|mutate|snapshot|inspect> ... (got: ${command ?? "nothing"})`
    );
  }

  const options = {
    command,
    boardId: undefined,
    title: undefined,
    file: undefined,
    output: undefined,
  };
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--title") {
      options.title = requireValue(rest, (i += 1), "--title");
    } else if (arg === "--file") {
      options.file = requireValue(rest, (i += 1), "--file");
    } else if (arg === "--output") {
      options.output = requireValue(rest, (i += 1), "--output");
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (command === "mutate" || command === "snapshot" || command === "inspect") {
    options.boardId = positional[0];
    if (!options.boardId) throw new Error(`board ${command} requires a <boardId>`);
  }
  if (command === "inspect" && !options.output) {
    throw new Error("board inspect requires --output <path>");
  }
  return options;
}

function requireValue(args, index, flagName) {
  const value = args[index];
  if (value === undefined) throw new Error(`${flagName} requires a value`);
  return value;
}

async function extractError(response) {
  const text = await response.text();
  try {
    const json = JSON.parse(text);
    return json.error || json.message || text;
  } catch {
    return text;
  }
}

/**
 * Run one board command. `bridgeFetch(path, options)` must be scoped to the
 * current session (i.e. it prepends `/sessions/:id`). Returns the stdout string.
 * Throws on any non-2xx — in particular a failed `snapshot` throws rather than
 * returning an empty document, so the caller never mistakes "board unreachable"
 * for "board is empty".
 */
export async function runBoardCommand({ argv, bridgeFetch, readPayload, captureInspection }) {
  const args = parseBoardArgs(argv);

  if (args.command === "create") {
    const response = await bridgeFetch("/board", {
      method: "POST",
      body: JSON.stringify({ title: args.title }),
    });
    if (!response.ok) throw new Error(`Board create failed: ${await extractError(response)}`);
    return await response.text();
  }

  if (args.command === "mutate") {
    const payload = await readPayload(args.file);
    const response = await bridgeFetch(`/board/${args.boardId}/mutate`, {
      method: "POST",
      body: payload,
    });
    if (!response.ok) throw new Error(`Board mutate failed: ${await extractError(response)}`);
    return await response.text();
  }

  if (args.command === "inspect") {
    const response = await bridgeFetch(`/board/${args.boardId}/inspect`, { method: "POST" });
    if (!response.ok) throw new Error(`Board inspect failed: ${await extractError(response)}`);

    let url;
    try {
      ({ url } = JSON.parse(await response.text()));
    } catch {
      throw new Error("Board inspect failed: invalid inspection URL response");
    }
    if (typeof url !== "string" || !url) {
      throw new Error("Board inspect failed: inspection URL missing");
    }

    const capture = captureInspection ?? captureBoardInspection;
    const dimensions = await capture({ url, output: args.output });
    return `Saved ${args.output} (${dimensions.width}x${dimensions.height})`;
  }

  // snapshot
  const response = await bridgeFetch(`/board/${args.boardId}/snapshot`);
  if (!response.ok) throw new Error(`Board snapshot failed: ${await extractError(response)}`);
  return await response.text();
}

export async function captureBoardInspection({
  url,
  output,
  executeBrowser = executeAgentBrowser,
  readOutput = readFile,
}) {
  const session = `board-inspect-${process.pid}-${Date.now()}`;
  const common = ["--session", session];
  const run = (...args) => executeBrowser([...common, ...args]);

  try {
    await run(
      "set",
      "viewport",
      String(INSPECTION_VIEWPORT.width),
      String(INSPECTION_VIEWPORT.height)
    );
    await run("open", url);
    const marker = "[data-board-inspection-state]";
    await run("wait", marker);
    const state = await run("get", "attr", marker, "data-board-inspection-state");
    if (state !== "ready") {
      const pageError = await run("get", "attr", marker, "data-board-inspection-error").catch(
        () => "Board inspection failed"
      );
      throw new Error(pageError || "Board inspection failed");
    }
    await run("screenshot", output, "--json");
    return pngDimensions(await readOutput(output));
  } finally {
    await run("close").catch(() => undefined);
  }
}

async function executeAgentBrowser(args) {
  const { stdout } = await execFileAsync("agent-browser", args, {
    env: { ...process.env, AGENT_BROWSER_DEFAULT_TIMEOUT: "30000" },
    timeout: 35_000,
  });
  return stdout.trim();
}

function pngDimensions(buffer) {
  const pngSignature = "89504e470d0a1a0a";
  if (buffer.length < 24 || buffer.subarray(0, 8).toString("hex") !== pngSignature) {
    throw new Error("Board inspection did not produce a valid PNG");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// ─── CLI wiring (only when executed directly) ──────────────────────────────

function buildBridgeFetch(env) {
  const baseUrl = env.CONTROL_PLANE_URL || "http://localhost:8787";
  const token = env.SANDBOX_AUTH_TOKEN;
  if (!token) throw new Error("SANDBOX_AUTH_TOKEN not set");
  let sessionId = "";
  try {
    const config = JSON.parse(env.SESSION_CONFIG || "{}");
    sessionId = config.sessionId || config.session_id || "";
  } catch {
    sessionId = "";
  }
  if (!sessionId) throw new Error("Session ID not found in SESSION_CONFIG environment variable");

  return (path, options = {}) => {
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${token}`);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return fetch(`${baseUrl}/sessions/${sessionId}${path}`, { ...options, headers });
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const bridgeFetch = buildBridgeFetch(process.env);
  const readPayload = (file) => (file ? readFile(file, "utf8") : readStdin());
  const out = await runBoardCommand({ argv: process.argv.slice(2), bridgeFetch, readPayload });
  process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
