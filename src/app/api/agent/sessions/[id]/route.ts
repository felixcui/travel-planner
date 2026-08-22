import { NextResponse } from "next/server";
import { FileTripRepository } from "@/server/repositories/files";
import { TravelAgentService } from "@/server/services/agent";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await new TravelAgentService().getSession(id);
  if (!session) return NextResponse.json({ error: "对话不存在" }, { status: 404 });
  const trip = session.tripId ? await new FileTripRepository().get(session.tripId) : null;
  return NextResponse.json({ session, trip });
}
