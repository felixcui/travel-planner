import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

const COOKIE = "travel_planner_admin";
function expected() { return createHmac("sha256", process.env.OPS_SECRET ?? "travel-planner-local-admin").update("admin-session-v1").digest("hex"); }

export async function isAdmin() {
  const value = (await cookies()).get(COOKIE)?.value ?? "";
  const target = expected();
  return value.length === target.length && timingSafeEqual(Buffer.from(value), Buffer.from(target));
}

export function adminCookieValue() { return { name: COOKIE, value: expected(), options: { httpOnly: true, sameSite: "strict" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: 8 * 3600 } }; }
