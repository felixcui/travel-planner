import { NextResponse } from "next/server";
import { PlanSchema } from "@/lib/domain";
import { recalculatePlan } from "@/server/services/planning";

export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const plan = PlanSchema.parse(body.plan);
    return NextResponse.json(await recalculatePlan(body.request, plan));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "重新计算失败" }, { status: 400 });
  }
}
