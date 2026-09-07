import { NextResponse } from "next/server";
import { visitorRepositories } from "@/server/visitor";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { agent, trips } = await visitorRepositories();
  const session = await agent.getSession(id);
  if (!session) return NextResponse.json({ error: "对话不存在" }, { status: 404 });
  const trip = session.tripId ? await trips.get(session.tripId) : null;
  return NextResponse.json({ session, trip });
}
