/**
 * 一次性修补脚本：修复 trip 文件中内联景点的错误坐标（第二轮）。
 *
 * 第一轮只修复了磁盘 data/places 中的破损 place，但很多 trip 文件里的 place 是内联数据，
 * 其 id 并不存在于磁盘（或名字带"景区/风景名胜区"等后缀变体），坐标仍聚集在珠三角/重庆等错误区域。
 *
 * 匹配优先级：
 *   1. place.id 命中磁盘 place → 直接采用磁盘坐标
 *   2. place.name 命中磁盘 place → 采用磁盘坐标
 *   3. 名字去掉常见后缀（景区/风景名胜区/国家地质公园等）后命中 → 采用磁盘坐标
 *   4. 以上都不行 → 用 geocodeOrEstimate 按 destination + 名称现场解析
 *
 * 运行：set -a; source .env.local; set +a; npx vite-node -c vitest.config.ts scripts/fix-trip-places.mts
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import glob from "fast-glob";
import type { Place, TripBundle } from "../src/lib/domain";
import { haversine } from "../src/lib/utils";
import { geocodeOrEstimate, OsmMapProvider } from "../src/server/providers/map";

const PLACES_DIR = path.resolve(process.cwd(), "data/places");
const TRIPS_DIR = path.resolve(process.cwd(), "data/trips");

const ROUTE_REGION_FALLBACK: Record<string, { lat: number; lng: number }> = {
  "青甘": { lat: 36.623, lng: 101.78 },
  "青甘大": { lat: 36.623, lng: 101.78 },
  "青甘大环": { lat: 36.623, lng: 101.78 },
  "青甘大环线": { lat: 36.623, lng: 101.78 },
  "北疆": { lat: 43.83, lng: 87.62 },
  "北疆大": { lat: 43.83, lng: 87.62 },
  "北疆大环": { lat: 43.83, lng: 87.62 },
  "北疆大环线": { lat: 43.83, lng: 87.62 },
  "新疆北疆": { lat: 43.83, lng: 87.62 },
  "新疆北疆大": { lat: 43.83, lng: 87.62 },
  "新疆北疆大环": { lat: 43.83, lng: 87.62 },
  "新疆北疆大环线": { lat: 43.83, lng: 87.62 },
  "南疆": { lat: 39.47, lng: 75.99 },
  "川西": { lat: 30.65, lng: 104.07 },
  "川西小": { lat: 30.65, lng: 104.07 },
  "川西小环": { lat: 30.65, lng: 104.07 },
  "川西小环线": { lat: 30.65, lng: 104.07 },
  "甘南": { lat: 34.99, lng: 104.07 },
  "甘南大": { lat: 34.99, lng: 104.07 },
  "甘南大环": { lat: 34.99, lng: 104.07 },
  "甘南大环线": { lat: 34.99, lng: 104.07 },
  "河西走廊": { lat: 38.93, lng: 100.45 },
  "丝绸之路": { lat: 40.14, lng: 94.66 },
};

function routeFallbackCenter(destination: string) {
  return ROUTE_REGION_FALLBACK[destination] ?? null;
}

const SUFFIXES = ["风景名胜区", "国家地质公园", "国家湿地公园", "旅游风景区", "地质公园", "自然保护区", "景区", "观景台", "观景平台", "森林公园", "观景"];
function normalize(name: string) {
  let n = name;
  for (const s of SUFFIXES) {
    if (n.endsWith(s)) { n = n.slice(0, -s.length); break; }
  }
  return n;
}

// 明显跑偏区域：珠三角（青甘误匹配）、川渝（北疆误匹配重庆）
function isObviouslyWrong(lat: number, lng: number) {
  const pearl = lat >= 21.5 && lat <= 24.5 && lng >= 112 && lng <= 115.5;
  const chongqing = lat >= 28.5 && lat <= 31 && lng >= 105.5 && lng <= 108;
  return pearl || chongqing;
}

async function main() {
  // 载入磁盘 place 索引
  const byId = new Map<string, Place>();
  const byName = new Map<string, Place>();
  const entries = await readdir(PLACES_DIR);
  for (const entry of entries) {
    if (!entry.startsWith("place_") || !entry.endsWith(".json")) continue;
    const data = JSON.parse(await readFile(path.join(PLACES_DIR, entry), "utf8")) as Place;
    byId.set(data.id, data);
    byName.set(data.name, data);
  }
  console.log(`磁盘 place 索引: ${byId.size} 个`);

  const map = new OsmMapProvider();
  const tripFiles = await glob("trip_*.json", { cwd: TRIPS_DIR, onlyFiles: true });
  console.log(`trip 文件: ${tripFiles.length} 个`);

  let totalFixed = 0;
  let geocoded = 0;
  for (const file of tripFiles) {
    const filePath = path.join(TRIPS_DIR, file);
    const raw = await readFile(filePath, "utf8");
    let bundle: TripBundle;
    try { bundle = JSON.parse(raw) as TripBundle; } catch { console.warn(`${file}: JSON 解析失败，跳过`); continue; }
    const destination = bundle.request?.destination ?? "";
    let fixed = 0;
    for (const plan of bundle.plans ?? []) {
      for (const day of plan.days ?? []) {
        for (const activity of day.activities ?? []) {
          const place = activity.place;
          if (!place?.location?.lat || !place?.location?.lng) continue;
          const { lat, lng } = place.location;
          if (!isObviouslyWrong(lat, lng) && place.locationStatus !== "estimated") continue;
          // 1) id 命中
          const byIdHit = byId.get(place.id);
          // 2) 名字命中
          const byNameHit = byName.get(place.name);
          // 3) 归一化名字命中
          const byNormHit = byName.get(normalize(place.name));
          const src = byIdHit ?? byNameHit ?? byNormHit;
          if (src && src.location?.lat && src.location?.lng) {
            place.location = { lat: src.location.lat, lng: src.location.lng };
            place.locationStatus = src.locationStatus;
            place.address = src.address;
            fixed++;
            continue;
          }
          // 4) 现场解析
          const destinationLocation = await map.geocodeDestination(destination);
          const center = routeFallbackCenter(destination) ?? destinationLocation?.location ?? null;
          if (!center) continue;
          const result = await geocodeOrEstimate(map, place.name, destination, center, 0);
          // 结果必须落在目的地中心 900km 内，防止 Nominatim 的无关匹配写回
          const distKm = result && result.location?.lat ? haversine(result.location, center) / 1000 : Number.POSITIVE_INFINITY;
          if (result && distKm <= 900) {
            place.location = { lat: result.location.lat, lng: result.location.lng };
            place.locationStatus = result.verified ? "verified" : "estimated";
            place.address = result.address;
            fixed++;
            geocoded++;
            console.log(`  [geocode] ${destination} → ${place.name}: (${result.location.lat.toFixed(4)}, ${result.location.lng.toFixed(4)}) verified=${result.verified} 距中心≈${Math.round(distKm)}km`);
          } else {
            console.log(`  [skip] ${destination} → ${place.name}: 无有效结果或离群，保留原样`);
          }
        }
      }
    }
    if (fixed) {
      await writeFile(filePath, JSON.stringify(bundle, null, 2), "utf8");
      totalFixed += fixed;
      console.log(`${file}: 修复 ${fixed} 处`);
    }
  }
  console.log(`\n完成：共修复 ${totalFixed} 处（其中现场 geocode ${geocoded} 处）。`);
}

main().catch((error) => {
  console.error("脚本异常：", error);
  process.exit(1);
});
