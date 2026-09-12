import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { acknowledgeContextReset } from "./acknowledge-context-reset";

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

describe("acknowledgeContextReset", () => {
  it("returns true and stays quiet when the release succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { status: "released" })));

    expect(await acknowledgeContextReset("session-1")).toBe(true);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("stays quiet on the nothing-held 409", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(409, { error: "No context-reset hold" }))
    );

    expect(await acknowledgeContextReset("session-1")).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("toasts a generic failure for other server errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, { error: "boom" })));

    expect(await acknowledgeContextReset("session-1")).toBe(false);
    expect(toast.error).toHaveBeenCalledWith("Failed to acknowledge context reset");
  });
});
