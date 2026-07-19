import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";
import type * as Handlers from "../src/handlers";

const handlePullRequestOpened = vi.fn();

vi.mock("../src/handlers", async (importOriginal) => {
  const actual = await importOriginal<typeof Handlers>();
  return { ...actual, handlePullRequestOpened };
});

const app = (await import("../src/index")).default;

const SECRET = "test-webhook-secret";

async function sign(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

function createMockKV() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

function makeEnv(controlPlaneFetch: ReturnType<typeof vi.fn>) {
  return {
    GITHUB_KV: createMockKV(),
    GITHUB_WEBHOOK_SECRET: SECRET,
    GITHUB_BOT_USERNAME: "test-bot[bot]",
    DEPLOYMENT_NAME: "test",
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    LOG_LEVEL: "error",
    INTERNAL_CALLBACK_SECRET: "internal-secret",
    CONTROL_PLANE: { fetch: controlPlaneFetch },
  } as unknown as Env;
}

function makeCtx() {
  return {
    props: {},
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as any;
}

const pullRequestOpenedBody = JSON.stringify({
  action: "opened",
  pull_request: {
    number: 42,
    title: "Add a thing",
    body: "does the thing",
    state: "open",
    draft: false,
    user: { login: "alice" },
    head: { ref: "feature/test", sha: "abc123", repo: { id: 1 } },
    base: { ref: "main", repo: { id: 1 } },
  },
  repository: { owner: { login: "test" }, name: "repo", private: false },
  sender: { login: "alice", id: 1, avatar_url: "https://example.test/a.png" },
});

describe("automation forward decoupling", () => {
  beforeEach(() => {
    handlePullRequestOpened.mockReset();
  });

  it("forwards the normalized event when the built-in handler throws", async () => {
    handlePullRequestOpened.mockRejectedValue(new Error("no anthropic credentials"));
    const controlPlaneFetch = vi.fn(async () => new Response(null, { status: 202 }));
    const ctx = makeCtx();

    const res = await app.fetch(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body: pullRequestOpenedBody,
        headers: {
          "X-Hub-Signature-256": await sign(SECRET, pullRequestOpenedBody),
          "X-GitHub-Event": "pull_request",
          "X-GitHub-Delivery": "delivery-throwing-handler",
        },
      }),
      makeEnv(controlPlaneFetch),
      ctx
    );

    expect(res.status).toBe(200);
    await ctx.waitUntil.mock.calls[0]?.[0];

    expect(handlePullRequestOpened).toHaveBeenCalledOnce();
    expect(controlPlaneFetch).toHaveBeenCalledOnce();
    const [url, init] = controlPlaneFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://internal/internal/github-event");
    expect(JSON.parse(init.body as string)).toMatchObject({
      eventType: "pull_request.opened",
      repoOwner: "test",
      repoName: "repo",
    });
  });

  it("forwards the normalized event when the built-in handler succeeds", async () => {
    handlePullRequestOpened.mockResolvedValue({
      outcome: "handled",
      session_id: "sess-1",
      message_id: "msg-1",
      handler_action: "auto_review",
    });
    const controlPlaneFetch = vi.fn(async () => new Response(null, { status: 202 }));
    const ctx = makeCtx();

    await app.fetch(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body: pullRequestOpenedBody,
        headers: {
          "X-Hub-Signature-256": await sign(SECRET, pullRequestOpenedBody),
          "X-GitHub-Event": "pull_request",
          "X-GitHub-Delivery": "delivery-ok-handler",
        },
      }),
      makeEnv(controlPlaneFetch),
      ctx
    );
    await ctx.waitUntil.mock.calls[0]?.[0];

    expect(controlPlaneFetch).toHaveBeenCalledOnce();
  });
});
