import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const response = await controlPlaneUserFetch("/scheduled-tasks");
  return NextResponse.json(await response.json(), { status: response.status });
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json();
  const response = await controlPlaneUserFetch("/scheduled-tasks", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return NextResponse.json(await response.json(), { status: response.status });
}
