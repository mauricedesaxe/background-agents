import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const response = await controlPlaneUserFetch(`/scheduled-tasks/${encodeURIComponent(id)}`);
  return NextResponse.json(await response.json(), { status: response.status });
}
