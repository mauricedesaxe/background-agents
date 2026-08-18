import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerAuthSession();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const response = await controlPlaneUserFetch(
    `/scheduled-tasks/${encodeURIComponent(id)}/cancel`,
    {
      method: "POST",
    }
  );
  return NextResponse.json(await response.json(), { status: response.status });
}
