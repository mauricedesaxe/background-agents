import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionPromptRoutes } from "./session-prompt";
import type { RequestContext } from "./shared";
import type { Env } from "../types";

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

function createCtx(): RequestContext {
  return {
    trace_id: "trace-1",
    request_id: "req-1",
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  };
}

async function postPrompt(body: unknown): Promise<Response> {
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
    createCtx()
  );
}

/** The attachments forwarded to the session runtime on the last accepted prompt. */
function forwardedAttachments(): unknown {
  const init = runtimeFetch.mock.calls.at(-1)?.[2] as RequestInit;
  return JSON.parse(String(init.body)).attachments;
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
