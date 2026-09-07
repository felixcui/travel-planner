import { NextResponse } from "next/server";
import { generateTrip } from "@/server/services/planning";
import { visitorRepositories } from "@/server/visitor";

export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const { trips } = await visitorRepositories(true);
    const bundle = await generateTrip(await request.json());
    return NextResponse.json(await trips.save(bundle));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "行程生成失败" }, { status: 500 });
  }
}
