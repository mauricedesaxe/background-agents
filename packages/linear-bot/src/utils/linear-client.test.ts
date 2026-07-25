import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { emitAgentActivity, fetchUser, linearGraphQL } from "./linear-client";
import type { LinearApiClient } from "./linear-client";

const client: LinearApiClient = {
  accessToken: "test-token",
  organizationId: "org-1",
  renewAccessToken: vi.fn(async () => "renewed-token"),
};

function mockFetchResponse(data: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(data),
    })
  );
}

describe("linearGraphQL", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses a valid operation response at the HTTP boundary", async () => {
    mockFetchResponse({ data: { viewer: { id: "user-1" } } });

    const result = await linearGraphQL(
      client,
      "query ViewerIdentity { viewer { id } }",
      {},
      z.object({ data: z.object({ viewer: z.object({ id: z.string() }) }) })
    );

    expect(result).toEqual({ data: { viewer: { id: "user-1" } } });
  });

  it("names the operation without exposing a malformed response", async () => {
    mockFetchResponse({ data: { viewer: { id: "secret-response-value" } } });

    const request = linearGraphQL(
      client,
      "query ViewerIdentity { viewer { id } }",
      {},
      z.object({ data: z.object({ viewer: z.object({ id: z.number() }) }) })
    );

    await expect(request).rejects.toThrow("Linear ViewerIdentity response validation failed");
    await expect(request).rejects.not.toThrow("secret-response-value");
  });

  it("names a GraphQL error without exposing its response message", async () => {
    mockFetchResponse({ errors: [{ message: "secret-upstream-message" }] });

    const request = linearGraphQL(
      client,
      "query ViewerIdentity { viewer { id } }",
      {},
      z.object({ data: z.object({ viewer: z.object({ id: z.string() }) }) })
    );

    await expect(request).rejects.toThrow("Linear ViewerIdentity GraphQL error");
    await expect(request).rejects.not.toThrow("secret-upstream-message");
  });

  it("rejects a malformed GraphQL error envelope", async () => {
    mockFetchResponse({ errors: [{}] });

    const request = linearGraphQL(
      client,
      "query ViewerIdentity { viewer { id } }",
      {},
      z.object({ data: z.object({ viewer: z.object({ id: z.string() }) }) })
    );

    await expect(request).rejects.toThrow("Linear ViewerIdentity response validation failed");
  });
});

describe("fetchUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns user with name and email", async () => {
    mockFetchResponse({
      data: {
        user: { id: "user-1", name: "Alice", email: "alice@example.com" },
      },
    });

    const result = await fetchUser(client, "user-1");
    expect(result).toEqual({
      id: "user-1",
      name: "Alice",
      email: "alice@example.com",
    });
  });

  it("returns null email when user has no email", async () => {
    mockFetchResponse({
      data: {
        user: { id: "user-2", name: "Bob", email: null },
      },
    });

    const result = await fetchUser(client, "user-2");
    expect(result).toEqual({
      id: "user-2",
      name: "Bob",
      email: null,
    });
  });

  it("returns null when user is not found", async () => {
    mockFetchResponse({ data: { user: null } });

    const result = await fetchUser(client, "nonexistent");
    expect(result).toBeNull();
  });

  it("returns null on API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      })
    );

    const result = await fetchUser(client, "user-1");
    expect(result).toBeNull();
  });

  it("returns null on GraphQL errors payload", async () => {
    mockFetchResponse({
      data: null,
      errors: [{ message: "Not authorized" }],
    });

    const result = await fetchUser(client, "user-1");
    expect(result).toBeNull();
  });
});

describe("emitAgentActivity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports a failed terminal activity delivery", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

    await expect(
      emitAgentActivity(client, "agent-session-1", {
        type: "response",
        body: "Finished",
      })
    ).resolves.toBe(false);
  });
});
