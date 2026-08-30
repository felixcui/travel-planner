/**
 * Phase 3 冒烟：验证规划期 LLM 顾问（时长分配 / 强度评估 / 砍景点）在真实 GLM 下的表现。
 * 运行：set -a; source .env.local; set +a; npx vite-node -c vitest.config.ts scripts/phase3-smoke.mts
 */
import { generateTrip } from "../src/server/services/planning";

async function main() {
  const t0 = Date.now();
  const bundle = await generateTrip({
    destination: "伊犁",
    days: 3,
    adults: 2,
    children: 1,
    childAges: [7],
    seniors: 0,
    pace: "balanced",
    interests: ["自然风光", "湖泊"],
    mustGo: ["赛里木湖", "那拉提草原"],
    avoid: [],
    startPoint: "",
    endPoint: "",
    earliestDeparture: "09:00",
    latestArrival: "19:30",
    maxDriveHours: 4,
    month: "8月",
    notes: "",
  });
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`生成完成：${seconds}s，${bundle.plans.length} 套方案，sourceMode=${bundle.sourceMode}\n`);

  for (const plan of bundle.plans) {
    console.log(`=== 方案「${plan.name}」===`);
    for (const day of plan.days) {
      console.log(`第${day.day}天 ${day.title} | 强度=${day.intensity} | 驾驶=${(day.totalDriveS / 3600).toFixed(1)}h | 距离=${Math.round(day.totalDistanceM / 1000)}km`);
      for (const activity of day.activities) {
        console.log(`  - ${activity.place.name}（${activity.place.category}）${activity.startTime}-${activity.endTime} ${activity.durationMin}min [${activity.place.locationStatus}]`);
      }
      for (const issue of day.issues) console.log(`  ! [${issue.level}/${issue.code}] ${issue.message}`);
    }
    console.log("");
  }
}

main().catch((error) => {
  console.error("冒烟失败：", error);
  process.exit(1);
});
