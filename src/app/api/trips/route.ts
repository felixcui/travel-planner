import { NextResponse } from "next/server";
import { FileTripRepository } from "@/server/repositories/files";
import { summarizeTrip } from "@/server/services/trips";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const trips = await new FileTripRepository().list();
    return NextResponse.json({ trips: trips.map(summarizeTrip) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "行程列表读取失败" }, { status: 500 });
  }
}
