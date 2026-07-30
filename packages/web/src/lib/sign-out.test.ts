import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ signOut: vi.fn(), toastError: vi.fn() }));
vi.mock("next-auth/react", () => ({ signOut: mocks.signOut }));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));

import { revokeAndSignOut } from "./sign-out";

beforeEach(() => {
  mocks.signOut.mockReset();
  mocks.toastError.mockReset();
  vi.unstubAllGlobals();
});

describe("revokeAndSignOut", () => {
  it("awaits revocation before clearing the NextAuth session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await revokeAndSignOut();

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/oi-revoke", { method: "POST" });
    expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.signOut.mock.invocationCallOrder[0]
    );
  });

  it("retains the browser session when revocation is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await revokeAndSignOut();
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith("Couldn't sign out securely. Please try again.");
  });

  it("retains the browser session when revocation is rejected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    await revokeAndSignOut();
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
  });
});
