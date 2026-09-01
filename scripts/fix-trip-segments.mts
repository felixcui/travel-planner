/**
 * 一次性修复脚本：重算行程文件中基于旧错误坐标生成的 segments 路线几何。
 *
 * 背景：地图坐标修复只修正了 place.location，但 trip 里的 day.segments 仍是
 * 生成时基于错误坐标（珠三角/重庆）计算出的 OSRM 路线，导致地图连线乱飞。
 * 本脚本对每个 trip 的每个 plan 调用 recalculatePlan 按最新 place 坐标重算全部段。
 *
 * 运行：/Users/felix/.workbuddy/binaries/node/versions/22.22.2-2/bin/node --env-file=.env ./node_modules/vite-node/vite-node.mjs -c vitest.config.ts scripts/fix-trip-segments.mts
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { recalculatePlan } from "../src/server/services/planning";
import { FileTripRepository } from "../src/server/repositories/files";

const TRIPS_DIR = path.resolve(process.cwd(), "data/trips");

async function main() {
  const repo = new FileTripRepository();
  const files = (await readdir(TRIPS_DIR)).filter((file) => file.endsWith(".json"));
  let tripsFixed = 0;
  let segmentsFixed = 0;

  for (const file of files) {
    const bundle = await repo.get(file.replace(/\.json$/, ""));
    if (!bundle) {
      console.log(`[skip] ${file.slice(0, 16)} 无法解析`);
      continue;
    }
    const updatedPlans = [];
    let planChanged = false;
    for (const plan of bundle.plans) {
      const oldCount = plan.days.reduce((sum, day) => sum + day.segments.length, 0);
      const rebuilt = await recalculatePlan(bundle.request, plan);
      const newCount = rebuilt.days.reduce((sum, day) => sum + day.segments.length, 0);
      if (newCount !== oldCount) {
        console.log(`[warn] ${file.slice(0, 16)} plan ${plan.name}: segments ${oldCount} -> ${newCount}`);
      }
      segmentsFixed += oldCount;
      planChanged = true;
      updatedPlans.push(rebuilt);
    }
    if (planChanged) {
      const now = new Date().toISOString();
      const updated = { ...bundle, plans: updatedPlans, updatedAt: now };
      await repo.save(updated);
      tripsFixed += 1;
      console.log(`[ok] ${file.slice(0, 16)}: ${bundle.plans.length} 个 plan 已重算全部 segments`);
    }
  }
  console.log(`完成：${tripsFixed} 个 trip 重算，共 ${segmentsFixed} 条 segments`);
}

main().catch((error) => {
  console.error("[fix-trip-segments] 失败:", error);
  process.exit(1);
});
