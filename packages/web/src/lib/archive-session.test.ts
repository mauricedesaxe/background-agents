import { afterEach, describe, expect, it, vi } from "vitest";

const { mockBrowserApiFetch } = vi.hoisted(() => ({ mockBrowserApiFetch: vi.fn() }));

vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: mockBrowserApiFetch }));

import { archiveSession, archiveSessions } from "./archive-session";

afterEach(() => {
  vi.clearAllMocks();
});

describe("archiveSession", () => {
  it("returns the API error as a failed outcome", async () => {
    mockBrowserApiFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "Archive denied" }), { status: 403 })
    );

    await expect(archiveSession("session-1")).resolves.toEqual({
      kind: "failed",
      sessionId: "session-1",
      reason: "Archive denied",
    });
  });

  it("limits bulk archive requests to four concurrent calls", async () => {
    let activeRequests = 0;
    let highestConcurrency = 0;
    const resolveRequests: Array<() => void> = [];
    mockBrowserApiFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          activeRequests += 1;
          highestConcurrency = Math.max(highestConcurrency, activeRequests);
          resolveRequests.push(() => {
            activeRequests -= 1;
            resolve(new Response(null, { status: 200 }));
          });
        })
    );

    const archived = archiveSessions(new Set(["one", "two", "three", "four", "five", "six"]));
    expect(mockBrowserApiFetch).toHaveBeenCalledTimes(4);

    while (resolveRequests.length > 0) {
      resolveRequests.shift()?.();
      await Promise.resolve();
    }

    await expect(archived).resolves.toEqual([
      { kind: "archived", sessionId: "one" },
      { kind: "archived", sessionId: "two" },
      { kind: "archived", sessionId: "three" },
      { kind: "archived", sessionId: "four" },
      { kind: "archived", sessionId: "five" },
      { kind: "archived", sessionId: "six" },
    ]);
    expect(highestConcurrency).toBe(4);
  });
});
