import { NextResponse } from "next/server";
import { isAdmin } from "@/server/auth";
import { createSearchProvider } from "@/server/providers/search";

export async function GET() {
  if (!(await isAdmin())) return NextResponse.json({ error: "未授权" }, { status: 401 });
  const provider = createSearchProvider();
  return NextResponse.json({ search: provider ? await provider.getUsage() : null, provider: provider ? "tavily" : "not_configured" });
}
