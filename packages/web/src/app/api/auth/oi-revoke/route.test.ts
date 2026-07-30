import { beforeEach, describe, expect, it, vi } from "vitest";
import { encode } from "next-auth/jwt";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("@/lib/control-plane-transport", () => ({ controlPlaneTokenFetch: vi.fn() }));

import { cookies } from "next/headers";
import { controlPlaneTokenFetch } from "@/lib/control-plane-transport";
import { POST } from "./route";

const SECRET = "test-nextauth-secret-for-oi-revoke";
const SECURE_COOKIE = "__Secure-next-auth.session-token";

function fakeCookieStore(initial: Record<string, string>): void {
  vi.mocked(cookies).mockResolvedValue({
    getAll: () => Object.entries(initial).map(([name, value]) => ({ name, value })),
  } as never);
}

beforeEach(() => {
  vi.mocked(controlPlaneTokenFetch).mockReset();
  vi.mocked(cookies).mockReset();
  vi.stubEnv("NEXTAUTH_SECRET", SECRET);
  vi.stubEnv("NEXTAUTH_URL", "https://open-inspect.example");
});

describe("POST /api/auth/oi-revoke", () => {
  it("revokes the refresh family from the decoded session", async () => {
    const jwt = await encode({
      token: { sub: "user-1", oiRefreshToken: "oi_rt_current" },
      secret: SECRET,
    });
    fakeCookieStore({ [SECURE_COOKIE]: jwt });
    vi.mocked(controlPlaneTokenFetch).mockResolvedValue(new Response(null, { status: 204 }));

    const response = await POST();

    expect(response.status).toBe(204);
    expect(controlPlaneTokenFetch).toHaveBeenCalledWith("/auth/tokens/revoke", {
      method: "POST",
      body: JSON.stringify({ refreshToken: "oi_rt_current" }),
    });
  });

  it("is idempotent when no refresh token remains", async () => {
    fakeCookieStore({});
    const response = await POST();
    expect(response.status).toBe(204);
    expect(controlPlaneTokenFetch).not.toHaveBeenCalled();
  });
});
