import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";
import { resolveCurrentUserId } from "@/lib/current-user";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const owner = await resolveCurrentUserId(session.user);
  if (!owner.ok) return NextResponse.json(owner.body, { status: owner.status });
  const { id } = await params;
  const response = await controlPlaneFetch(`/scheduled-tasks/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    body: JSON.stringify({ ownerUserId: owner.userId }),
  });
  return NextResponse.json(await response.json(), { status: response.status });
}
