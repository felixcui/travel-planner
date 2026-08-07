import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { TripBundleSchema } from "@/lib/domain";
import { FileShareRepository } from "@/server/repositories/files";

export async function POST(request: Request) {
  try {
    const bundle = TripBundleSchema.parse(await request.json());
    const token = randomBytes(24).toString("base64url");
    await new FileShareRepository().save(token, bundle);
    return NextResponse.json({ token, url: `/s/${token}` });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "分享创建失败" }, { status: 400 });
  }
}
