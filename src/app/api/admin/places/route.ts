import { NextResponse } from "next/server";
import { PlaceSchema } from "@/lib/domain";
import { isAdmin } from "@/server/auth";
import { FilePlaceRepository } from "@/server/repositories/files";

export async function GET() {
  if (!(await isAdmin())) return NextResponse.json({ error: "未授权" }, { status: 401 });
  return NextResponse.json(await new FilePlaceRepository().list());
}
export async function PATCH(request: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "未授权" }, { status: 401 });
  try {
    const place = PlaceSchema.parse(await request.json());
    place.knowledge.status = "confirmed";
    place.knowledge.lockedFields = ["summary", "highlights", "playTips", "openingHours", "reservation", "cautions"];
    place.knowledge.updatedAt = new Date().toISOString();
    return NextResponse.json(await new FilePlaceRepository().save(place));
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "保存失败" }, { status: 400 }); }
}
