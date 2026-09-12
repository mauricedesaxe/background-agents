import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { archiveSession } from "./archive-session";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("archiveSession", () => {
  it("returns true and stays quiet when the archive succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { status: "archived" })));

    expect(await archiveSession("session-1")).toBe(true);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("shows the server message for known lifecycle errors", async () => {
    const lifecycleErrors: Array<[number, string]> = [
      [404, "Session not found"],
      [409, "Session is not promptable"],
      [403, "Forbidden"],
    ];

    for (const [status, error] of lifecycleErrors) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(status, { error })));

      expect(await archiveSession("session-1")).toBe(false);
      expect(toast.error).toHaveBeenCalledWith(error);
    }
  });

  it("falls back to the generic message when a 5xx body leaks internals", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(500, {
          error: "Error: D1_EXECUTION_ERROR: internal use only: SELECT * FROM secrets",
        })
      )
    );

    expect(await archiveSession("session-1")).toBe(false);
    expect(toast.error).toHaveBeenCalledWith("Failed to archive session");
  });

  it("falls back to the generic message when the error body is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Bad Gateway", { status: 502 })));

    expect(await archiveSession("session-1")).toBe(false);
    expect(toast.error).toHaveBeenCalledWith("Failed to archive session");
  });

  it("falls back to the generic message when the request itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network offline")));

    expect(await archiveSession("session-1")).toBe(false);
    expect(toast.error).toHaveBeenCalledWith("Failed to archive session");
  });
});
