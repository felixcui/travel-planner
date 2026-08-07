import { NextResponse } from "next/server";
import { generateTrip } from "@/server/services/planning";
import { FileTripRepository } from "@/server/repositories/files";

export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const bundle = await generateTrip(await request.json());
    await new FileTripRepository().save(bundle);
    return NextResponse.json(bundle);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "行程生成失败" }, { status: 500 });
  }
}
