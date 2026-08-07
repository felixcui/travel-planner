import { NextResponse } from "next/server";
import { adminCookieValue, isAdmin } from "@/server/auth";

export async function GET() { return NextResponse.json({ authenticated: await isAdmin() }); }
export async function POST(request: Request) {
  const body = (await request.json()) as { secret?: string };
  if (!body.secret || body.secret !== (process.env.OPS_SECRET ?? "travel-planner-local-admin")) return NextResponse.json({ error: "运营密钥不正确" }, { status: 401 });
  const response = NextResponse.json({ authenticated: true }); const cookie = adminCookieValue(); response.cookies.set(cookie.name, cookie.value, cookie.options); return response;
}
export async function DELETE() { const response = NextResponse.json({ authenticated: false }); response.cookies.delete("travel_planner_admin"); return response; }
