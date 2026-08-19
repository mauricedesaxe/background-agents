import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function GET() {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const response = await controlPlaneUserFetch("/scheduled-tasks");
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch scheduled tasks:", error);
    return NextResponse.json({ error: "Failed to fetch scheduled tasks" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const taskBody = {
      instructions: body.instructions,
      executeAt: body.executeAt,
      scheduleTz: body.scheduleTz,
      model: body.model,
      reasoningEffort: body.reasoningEffort,
      repositories: body.repositories,
      environmentIds: body.environmentIds,
    };

    const response = await controlPlaneUserFetch("/scheduled-tasks", {
      method: "POST",
      body: JSON.stringify(taskBody),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to create scheduled task:", error);
    return NextResponse.json({ error: "Failed to create scheduled task" }, { status: 500 });
  }
}
