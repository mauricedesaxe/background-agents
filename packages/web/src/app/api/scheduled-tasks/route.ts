import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { getToken } from "next-auth/jwt";
import { authOptions } from "@/lib/auth";
import { buildAuthIdentity, buildScmCredentials } from "@/lib/build-auth-identity";
import { controlPlaneFetch } from "@/lib/control-plane";
import { resolveCurrentUserId } from "@/lib/current-user";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const owner = await resolveCurrentUserId(session.user);
  if (!owner.ok) return NextResponse.json(owner.body, { status: owner.status });
  const response = await controlPlaneFetch(
    `/scheduled-tasks?ownerUserId=${encodeURIComponent(owner.userId)}`
  );
  return NextResponse.json(await response.json(), { status: response.status });
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const owner = await resolveCurrentUserId(session.user);
  if (!owner.ok) return NextResponse.json(owner.body, { status: owner.status });
  const body = await request.json();
  const jwt = await getToken({ req: request });
  const participantUserId = session.user.id || session.user.email || "anonymous";
  const response = await controlPlaneFetch("/scheduled-tasks", {
    method: "POST",
    body: JSON.stringify({
      ...body,
      ownerUserId: owner.userId,
      participantUserId,
      ...buildAuthIdentity(session.user),
      ...buildScmCredentials(session.user, jwt),
    }),
  });
  return NextResponse.json(await response.json(), { status: response.status });
}
