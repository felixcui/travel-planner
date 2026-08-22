import { NextResponse } from "next/server";
import { TravelAgentService } from "@/server/services/agent";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as { tripId?: string };
    const session = await new TravelAgentService().createSession(body.tripId);
    return NextResponse.json(session, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "会话创建失败" }, { status: 400 });
  }
}
