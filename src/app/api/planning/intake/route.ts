import { NextResponse } from "next/server";
import { TripRequestSchema } from "@/lib/domain";

export async function POST(request: Request) {
  try {
    const input = TripRequestSchema.parse(await request.json());
    const questions = [] as Array<{ id: string; question: string }>;
    if (input.children > 0 && input.childAges.length === 0) questions.push({ id: "childAges", question: "孩子大约多大？这会影响连续驾驶和活动强度。" });
    return NextResponse.json(questions.length ? { status: "needs_input", questions, normalized: input } : { status: "ready", normalized: input });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "输入不完整" }, { status: 400 });
  }
}
