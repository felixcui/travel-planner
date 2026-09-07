import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { visitorRepositories } from "@/server/visitor";
import { FileShareRepository } from "@/server/repositories/files";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { id?: string };
    const { trips } = await visitorRepositories();
    const bundle = body.id ? await trips.get(body.id) : null;
    if (!bundle) return NextResponse.json({ error: "行程不存在或无权分享" }, { status: 404 });
    const token = randomBytes(24).toString("base64url");
    await new FileShareRepository().save(token, bundle);
    return NextResponse.json({ token, url: `/s/${token}` });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "分享创建失败" }, { status: 400 });
  }
}
