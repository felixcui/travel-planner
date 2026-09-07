import { NextResponse } from "next/server";
import { visitorRepositories } from "@/server/visitor";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as { tripId?: string };
    const { agent, trips } = await visitorRepositories(true);
    if (body.tripId && !await trips.get(body.tripId)) return NextResponse.json({ error: "行程不存在或无权访问" }, { status: 404 });
    const session = await agent.createSession(body.tripId);
    return NextResponse.json(session, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "会话创建失败" }, { status: 400 });
  }
}
