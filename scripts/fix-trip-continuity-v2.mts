/**
 * 修复地图路线不连续：一键脚本
 * 1. 修正被 Nominatim 误匹配到乌鲁木齐一带的坏坐标景点（喀纳斯景区/那拉提空中草原/巩乃斯林场/伊宁六星街）
 * 2. 用新 recalculatePlan 全量重算 trip 路线（含"前日住宿地→当日第一景"出发段 + "最后景→当日住宿地"入住段），
 *    保证前后天路线在地图上闭环衔接
 * 3. 输出验证报告：跨天衔接、每日首/末段端点、总里程
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recalculatePlan } from "../src/server/services/planning";

const TRIP_PATH = "data/trips/trip_f358e9ad-8db4-4f17-9324-47bd8f644f2e.json";
const PLACES_DIR = "data/places";

/** 人工核实的正确坐标（Nominatim / 行政区位）。locationStatus: verified=精确, estimated=景区近似 */
const FIXES: Record<string, { lat: number; lng: number; status: string; address: string }> = {
  "喀纳斯景区": { lat: 48.6912, lng: 87.03, status: "verified", address: "喀纳斯老村, 禾木哈纳斯蒙古民族乡, 布尔津县, 阿勒泰地区, 新疆维吾尔自治区" },
  "那拉提空中草原": { lat: 43.45, lng: 83.98, status: "estimated", address: "那拉提镇北侧山地（空中草原台地）, 新源县, 伊犁哈萨克自治州, 新疆维吾尔自治区" },
  "巩乃斯林场": { lat: 43.2652, lng: 84.5426, status: "verified", address: "巩乃斯镇, 和静县, 巴音郭楞蒙古自治州, 新疆维吾尔自治区" },
  "伊宁六星街": { lat: 43.9314, lng: 81.3064, status: "verified", address: "六星街, 解放路街道, 伊宁市, 伊犁哈萨克自治州, 新疆维吾尔自治区" },
  "伊宁": { lat: 43.92, lng: 81.28, status: "verified", address: "伊宁市, 伊犁哈萨克自治州, 新疆维吾尔自治区" },
};

function loadTrip() {
  return JSON.parse(readFileSync(TRIP_PATH, "utf8"));
}

function fixPlaces(trip: any) {
  const byName = new Map<string, { id: string; name: string }>();
  for (const day of trip.plans[0].days) {
    for (const activity of day.activities) {
      const p = activity.place;
      if (FIXES[p.name] && !byName.has(p.name)) byName.set(p.name, p);
    }
  }
  // 同步 place 库文件
  for (const file of readdirSync(PLACES_DIR)) {
    const path = join(PLACES_DIR, file);
    let rec: any;
    try {
      rec = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue; // 跳过空/损坏文件
    }
    const fix = FIXES[rec.name];
    if (fix) {
      rec.location = { lat: fix.lat, lng: fix.lng };
      rec.locationStatus = fix.status;
      rec.address = fix.address;
      writeFileSync(path, JSON.stringify(rec, null, 2) + "\n");
      console.log(`place 库修正: ${rec.name} → (${fix.lat.toFixed(4)}, ${fix.lng.toFixed(4)}) [${fix.status}]`);
    }
  }
  // 同步 trip 内联 place
  let n = 0;
  for (const day of trip.plans[0].days) {
    for (const activity of day.activities) {
      const p = activity.place;
      const fix = FIXES[p.name];
      if (fix) {
        p.location = { lat: fix.lat, lng: fix.lng };
        p.locationStatus = fix.status;
        p.address = fix.address;
        n++;
      }
    }
  }
  console.log(`trip 内联坐标修正: ${n} 处`);
}

async function main() {
  const trip = loadTrip();
  fixPlaces(trip);

  const plan = trip.plans.find((p: any) => p.id === trip.selectedPlanId) ?? trip.plans[0];
  console.log(`\n重算前: ${plan.name} v${plan.version}, 总里程 ${(plan.days.reduce((s: number, d: any) => s + d.totalDistanceM, 0) / 1000).toFixed(0)}km`);
  const recalculated = await recalculatePlan(trip.request, plan);
  plan.version = recalculated.version;
  plan.createdAt = recalculated.createdAt;
  plan.days = recalculated.days;
  trip.updatedAt = new Date().toISOString();
  writeFileSync(TRIP_PATH, JSON.stringify(trip, null, 2) + "\n");

  // 验证报告
  const days = plan.days;
  const totalKm = days.reduce((s: number, d: any) => s + d.totalDistanceM, 0) / 1000;
  const totalH = days.reduce((s: number, d: any) => s + d.totalDriveS, 0) / 3600;
  console.log(`重算完成: v${plan.version}, 总里程 ${totalKm.toFixed(0)}km, 驾驶 ${totalH.toFixed(1)}h`);
  console.log(`总段数: ${days.reduce((s: number, d: any) => s + d.segments.length, 0)} (期望 ≥ 活动数+天数)`);
  console.log("\n=== 每日路线 ===");
  let broken = 0;
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const segs = d.segments;
    const first = segs[0];
    const last = segs[segs.length - 1];
    const expectedOrigin = i === 0 ? (trip.request.startPoint || trip.request.destination) : days[i - 1].stay;
    const originOk = first && (first.fromName === expectedOrigin || stripStay(expectedOrigin).includes(first.fromName) || first.fromName.includes(stripStay(expectedOrigin)));
    const actCount = d.activities.filter((a: any) => a.type === "place").length;
    // 当日闭环：末段终点应贴近住宿地（stay 前缀）或 == 最后活动（住宿地=活动地）
    const lastAct = d.activities[d.activities.length - 1]?.place.name;
    const stayBase = stripStay(d.stay);
    const endTouchesStay = last && (last.toName === stayBase || last.toName === lastAct);
    if (!originOk) { broken++; console.log(`D${d.day} ✗ 出发地不符: 首段[${first?.fromName}] 应=[${expectedOrigin}]`); }
    if (!endTouchesStay) { broken++; console.log(`D${d.day} ✗ 未收尾住宿: 末段[${last?.toName}] stay=[${d.stay}] 活动末=[${lastAct}]`); }
    if (!first || segs.length < actCount) { broken++; console.log(`D${d.day} ✗ 段数异常: segs=${segs.length} act=${actCount}`); }
    const segDesc = segs.map((s: any) => `${s.fromName}→${s.toName}`).join(" | ");
    console.log(`D${d.day} [${d.title}] ${actCount}活动/${segs.length}段`);
    console.log(`    ${segDesc}`);
  }
  console.log(broken === 0 ? "\n✅ 全部天数路线闭环衔接" : `\n❌ ${broken} 处异常`);
}

function stripStay(stay: string) {
  const m = stay?.match(/^(.+?)[（(]/);
  return m ? m[1].trim() : stay;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
