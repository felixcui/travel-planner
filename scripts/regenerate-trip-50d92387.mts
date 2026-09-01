/**
 * 一次性恢复脚本：重新生成被截断的 trip_50d92387（北疆大环线 11 日）。
 *
 * 背景：地图坐标修复过程中，trip_50d92387-026f-478e-87ce-c69825a9340e.json
 * 在写回时被截断（8MB → 12KB，UnicodeEncodeError），已改名 .broken 隔离。
 * 本脚本从原请求参数（提取自 .broken 的 request 字段）调用 generateTrip 重建行程，
 * 生成的新 trip 会以新 id 保存到 data/trips/。
 *
 * 运行：set -a; source .env; set +a; npx vite-node -c vitest.config.ts scripts/regenerate-trip-50d92387.mts
 */
import { generateTrip } from "../src/server/services/planning";
import { FileTripRepository } from "../src/server/repositories/files";

const request = {
  destination: "北疆大环线",
  days: 11,
  adults: 2,
  children: 0,
  childAges: [] as number[],
  seniors: 0,
  pace: "balanced",
  interests: ["自然风光"],
  mustGo: ["喀纳斯", "禾木", "赛里木湖"],
  avoid: [] as string[],
  startPoint: "乌鲁木齐",
  endPoint: "乌鲁木齐",
  earliestDeparture: "09:00",
  latestArrival: "19:30",
  maxDriveHours: 6,
  notes: "",
};

async function main() {
  console.log("[regenerate] 开始生成北疆大环线 11 日行程（LLM + geocode + route，预计数分钟）…");
  const started = Date.now();
  const bundle = await generateTrip(request);
  await new FileTripRepository().save(bundle);
  const placeCount = bundle.plans.reduce(
    (sum, plan) =>
      sum +
      plan.days.reduce(
        (daySum, day) => daySum + day.activities.filter((item) => item.type === "place").length,
        0,
      ),
    0,
  );
  console.log(`[regenerate] 完成：新 trip id=${bundle.id} sourceMode=${bundle.sourceMode} 活动数=${placeCount} 耗时=${((Date.now() - started) / 1000).toFixed(0)}s`);
  const sample = bundle.plans[0]?.days[0]?.activities[0]?.place;
  if (sample) console.log(`[regenerate] 示例坐标：${sample.name} → (${sample.location?.lat}, ${sample.location?.lng}) ${sample.locationStatus}`);
}

main().catch((error) => {
  console.error("[regenerate] 失败:", error);
  process.exit(1);
});
