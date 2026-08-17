import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionPromptRoutes } from "./session-prompt";
import type { RequestContext } from "./shared";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";
import type { Principal } from "../auth/principal";

const runtimeFetch = vi.fn();

vi.mock("../session/runtime-client", () => ({
  createSessionRuntimeClient: () => ({ fetch: runtimeFetch }),
}));

function getHandler(method: string, path: string) {
  const pathname = new URL(`https://test.local${path}`).pathname;
  for (const route of sessionPromptRoutes) {
    if (route.method === method && route.pattern.test(pathname)) {
      return { handler: route.handler, match: pathname.match(route.pattern)! };
    }
  }
  throw new Error(`No route found for ${method} ${path}`);
}

function createCtx(principalOverride?: Principal): RequestContext {
  const principal: Principal = principalOverride ?? {
    kind: "user",
    userId: "user-1",
  };
  return {
    trace_id: "trace-1",
    request_id: "req-1",
    db: {} as SqlDatabase,
    principal,
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  } as unknown as RequestContext;
}

async function postPrompt(body: unknown, principal?: Principal): Promise<Response> {
  const path = "/sessions/session-1/prompt";
  const { handler, match } = getHandler("POST", path);
  return handler(
    new Request(`https://test.local${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { DB: {} as D1Database } as Env,
    match,
    createCtx(principal)
  );
}

/** The attachments forwarded to the session runtime on the last accepted prompt. */
function forwardedAttachments(): unknown {
  const init = runtimeFetch.mock.calls.at(-1)?.[2] as RequestInit;
  return JSON.parse(String(init.body)).attachments;
}

function forwardedPrompt(): Record<string, unknown> {
  const init = runtimeFetch.mock.calls.at(-1)?.[2] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe("POST /sessions/:id/prompt attachment boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeFetch.mockResolvedValue(new Response(JSON.stringify({ messageId: "m1" })));
  });

  it("forwards a valid attachment reference to the session runtime", async () => {
    const attachments = [{ attachmentId: "att-1", name: "diagram.png" }];

    const response = await postPrompt({ content: "look at this", attachments });

    expect(response.status).toBe(200);
    expect(forwardedAttachments()).toEqual(attachments);
  });

  it("omits attachments entirely when the client sends none", async () => {
    const response = await postPrompt({ content: "no attachments here" });

    expect(response.status).toBe(200);
    expect(forwardedAttachments()).toBeUndefined();
  });

  it("treats an explicit null the same as no attachments", async () => {
    const response = await postPrompt({ content: "explicit null", attachments: null });

    expect(response.status).toBe(200);
    expect(forwardedAttachments()).toBeUndefined();
  });

  it("rejects the removed freeform attachment shape", async () => {
    const response = await postPrompt({
      content: "stale client",
      attachments: [{ type: "image", name: "shot.png", url: "https://example.com/shot.png" }],
    });

    expect(response.status).toBe(400);
    expect(runtimeFetch).not.toHaveBeenCalled();
  });

  it("rejects an attachment id outside the id pattern", async () => {
    const response = await postPrompt({
      content: "bad id",
      attachments: [{ attachmentId: "../etc/passwd", name: "shot.png" }],
    });

    expect(response.status).toBe(400);
    expect(runtimeFetch).not.toHaveBeenCalled();
  });

  it("rejects attachments that are not a list", async () => {
    const response = await postPrompt({ content: "wrong type", attachments: "nope" });

    expect(response.status).toBe(400);
    expect(runtimeFetch).not.toHaveBeenCalled();
  });
});

describe("POST /sessions/:id/prompt callback ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeFetch.mockResolvedValue(new Response(JSON.stringify({ messageId: "m1" })));
  });

  it("derives the message source from the authenticated bot", async () => {
    const principal: Principal = { kind: "service", service: "slack-bot", actor: null };

    const response = await postPrompt({ content: "work", source: "linear" }, principal);

    expect(response.status).toBe(200);
    expect(forwardedPrompt().source).toBe("slack");
  });

  it("rejects callback context owned by another bot", async () => {
    const principal: Principal = { kind: "service", service: "slack-bot", actor: null };

    const response = await postPrompt(
      {
        content: "work",
        callbackContext: {
          source: "linear",
          issueId: "issue-1",
          issueIdentifier: "ENG-1",
          issueUrl: "https://linear.app/acme/issue/ENG-1",
          model: "anthropic/claude-haiku-4-5",
        },
      },
      principal
    );

    expect(response.status).toBe(400);
    expect(runtimeFetch).not.toHaveBeenCalled();
  });
});
