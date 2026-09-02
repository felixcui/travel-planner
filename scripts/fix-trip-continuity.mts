/**
 * 一次性脚本：重算行程路线，使每日 segments 首段为“前日住宿地 → 当日第一景点”，
 * 保证前后天路线连贯（前一天住在 A，后一天从 A 出发）。
 *
 * 用法：node --experimental-strip-types scripts/fix-trip-continuity.mts <tripId 或文件路径>
 * 默认处理 data/trips 下最新修改的 trip。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { recalculatePlan } from "../src/server/services/planning.ts";
import type { TripBundle } from "../src/lib/domain.ts";

const tripsDir = resolve("data/trips");
const arg = process.argv[2];

let target: string;
if (arg && arg.includes(".json")) {
  target = resolve(arg);
} else if (arg) {
  const file = readdirSync(tripsDir).find((name) => name.startsWith(arg));
  if (!file) throw new Error(`未找到 trip: ${arg}`);
  target = join(tripsDir, file);
} else {
  const latest = readdirSync(tripsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ name, mtime: 0 }))
    .sort((a, b) => b.mtime - a.mtime);
  const picked = readdirSync(tripsDir)
    .filter((name) => name.endsWith(".json"))
    .sort((a, b) => b.localeCompare(a))[0];
  target = join(tripsDir, picked);
  console.log("自动选择最新 trip:", picked);
}

const bundle = JSON.parse(readFileSync(target, "utf8")) as TripBundle;
const plan = bundle.plans.find((p) => p.id === bundle.selectedPlanId) ?? bundle.plans[0];
console.log(`行程: ${bundle.request.destination} ${bundle.request.days} 天, 方案: ${plan.name}`);

const fixed = await recalculatePlan(bundle.request, plan);
console.log(`重算完成, 版本 v${fixed.version}`);

// 汇总每日首段,验证衔接
const request = bundle.request;
let prevStay: string | undefined;
for (const day of fixed.days) {
  const first = day.segments[0];
  const origin = day.day === 1 ? (request.startPoint ?? request.destination) : prevStay;
  const ok = !origin || (first && (first.fromName === origin || first.fromName.includes(origin ?? "") || (origin ?? "").includes(first.fromName)));
  console.log(`  D${day.day}: ${first ? `${first.fromName} → ${first.toName}` : "(无路段)"} | 住 ${day.stay} | 出发地应= ${origin ?? "-"} ${ok ? "OK" : "MISS"}`);
  prevStay = day.stay;
}

bundle.plans = bundle.plans.map((p) => (p.id === fixed.id ? fixed : p));
bundle.updatedAt = new Date().toISOString();
writeFileSync(target, JSON.stringify(bundle, null, 2) + "\n");
console.log("已写回:", target);
