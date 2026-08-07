import { NextResponse } from "next/server";
import { generateTrip } from "@/server/services/planning";

export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    return NextResponse.json(await generateTrip(await request.json()));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "行程生成失败" }, { status: 500 });
  }
}
