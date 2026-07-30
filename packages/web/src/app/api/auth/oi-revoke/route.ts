import { getToken } from "next-auth/jwt";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { revokeWebSessionTokens } from "@/lib/oi-session";

export async function POST(): Promise<NextResponse> {
  const cookieStore = await cookies();
  const cookiePairs = Object.fromEntries(
    cookieStore.getAll().map((cookie) => [cookie.name, cookie.value])
  );
  const token = await getToken({
    req: { headers: {}, cookies: cookiePairs } as Parameters<typeof getToken>[0]["req"],
  });
  if (!token?.oiRefreshToken) return new NextResponse(null, { status: 204 });

  const revoked = await revokeWebSessionTokens(token.oiRefreshToken);
  return revoked
    ? new NextResponse(null, { status: 204 })
    : NextResponse.json({ error: "Failed to revoke session" }, { status: 502 });
}
