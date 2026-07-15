#!/usr/bin/env node

/**
 * `board` — drive an interactive tldraw whiteboard from the sandbox.
 *
 * The agent authors tldraw records as JSON and posts them to the control plane;
 * the board document lives in a Durable Object, not here (no tldraw runs in the
 * sandbox). Subcommands:
 *
 *   board create [--title "..."]        -> prints { boardId, ... }
 *   board mutate <boardId> [--file f]   -> applies { create, update, delete }
 *                                          (payload from --file or stdin)
 *   board snapshot <boardId>            -> prints the document snapshot JSON
 *                                          (redirect to a .tldr to save to git)
 *
 * Self-contained (bin scripts are copied flat onto PATH, so it can't import the
 * shared bridge client) but factored so the core is unit-testable with an
 * injected fetch.
 */

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const COMMANDS = new Set(["create", "mutate", "snapshot"]);

export function parseBoardArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || !COMMANDS.has(command)) {
    throw new Error(`Usage: board <create|mutate|snapshot> ... (got: ${command ?? "nothing"})`);
  }

  const options = { command, boardId: undefined, title: undefined, file: undefined };
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--title") {
      options.title = requireValue(rest, (i += 1), "--title");
    } else if (arg === "--file") {
      options.file = requireValue(rest, (i += 1), "--file");
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (command === "mutate" || command === "snapshot") {
    options.boardId = positional[0];
    if (!options.boardId) throw new Error(`board ${command} requires a <boardId>`);
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
export async function runBoardCommand({ argv, bridgeFetch, readPayload }) {
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

  // snapshot
  const response = await bridgeFetch(`/board/${args.boardId}/snapshot`);
  if (!response.ok) throw new Error(`Board snapshot failed: ${await extractError(response)}`);
  return await response.text();
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
