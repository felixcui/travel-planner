import { NextResponse } from "next/server";
import { migrateTripBundle } from "@/lib/domain";
import { visitorRepositories } from "@/server/visitor";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { trips } = await visitorRepositories();
    const bundle = await trips.get(id);
    if (!bundle) return NextResponse.json({ error: "未找到该行程" }, { status: 404 });
    return NextResponse.json(bundle);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "行程读取失败" }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { trips } = await visitorRepositories();
    const previous = await trips.get(id);
    if (!previous) return NextResponse.json({ error: "行程不存在或无权访问" }, { status: 404 });
    const bundle = migrateTripBundle(await request.json());
    if (bundle.id !== id) return NextResponse.json({ error: "行程标识不匹配" }, { status: 400 });
    return NextResponse.json(await trips.save({ ...bundle, agentSessionId: previous.agentSessionId }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "行程保存失败" }, { status: 400 });
  }
}
