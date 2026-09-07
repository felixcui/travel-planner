import { NextResponse } from "next/server";
import { visitorRepositories } from "@/server/visitor";
import { summarizeTrip } from "@/server/services/trips";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { trips: repository } = await visitorRepositories();
    const trips = await repository.list();
    return NextResponse.json({ trips: trips.map(summarizeTrip) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "行程列表读取失败" }, { status: 500 });
  }
}
