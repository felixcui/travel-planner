/**
 * 一次性修补脚本：重新富集 data/places 中明显跑偏的景点坐标。
 *
 * 历史事故：places/enrich 路由直接调用 map.geocode(destination, "中国")，未走 geocodeDestination 的
 * 字符重叠校验；与此同时 geocodeDestination 的 `length<4` 短路让“青甘”之类短查询通过校验，
 * 误匹配到香港“青嶼幹線”并把珠三角当作目的地中心；后续 geocodeOrEstimate 又围绕错误中心做
 * viewbox 偏置 + 距离阈值，导致“茶卡盐湖”“莫高窟”等青甘景点全部聚到香港一带。
 *
 * 修复要点：
 *   1. places/enrich 改为走 map.geocodeDestination
 *   2. geocodeDestination 去掉 `length<4` 短路，2/3 字查询要求 bigram 100% 命中
 *   3. places/enrich 提供 ROUTE_REGION_FALLBACK，在 geocodeDestination 整体失败时给出区域中心
 *
 * 本脚本与线上路由复用同一入口（geocodeDestination + geocodeOrEstimate + fallback 中心），
 * 并把“离中心 >900km”的离群结果视为失败（第一版脚本曾把此类垃圾结果写回磁盘，导致
 * 富蕴县→云南、北屯市→广西 等二次污染，此版本不再容忍离群点）。
 *
 * 运行：set -a; source .env.local; set +a; npx vite-node -c vitest.config.ts scripts/regeocode-broken-places.mts
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Place } from "../src/lib/domain";
import { haversine } from "../src/lib/utils";
import { geocodeOrEstimate, OsmMapProvider } from "../src/server/providers/map";

const PLACES_DIR = path.resolve(process.cwd(), "data/places");

const ROUTE_REGION_FALLBACK: Record<string, { lat: number; lng: number }> = {
  "青甘": { lat: 36.623, lng: 101.78 },
  "青甘大": { lat: 36.623, lng: 101.78 },
  "青甘大环": { lat: 36.623, lng: 101.78 },
  "青甘大环线": { lat: 36.623, lng: 101.78 },
  "北疆": { lat: 43.83, lng: 87.62 },
  "北疆大": { lat: 43.83, lng: 87.62 },
  "北疆大环": { lat: 43.83, lng: 87.62 },
  "北疆大环线": { lat: 43.83, lng: 87.62 },
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

// 与 places/enrich 路由保持一致的入口。环线类目的地优先使用人工核实的区域中心。
async function regeocode(destination: string, name: string, map: OsmMapProvider, index: number) {
  const destinationLocation = await map.geocodeDestination(destination);
  const fallbackCenter = routeFallbackCenter(destination);
  const center = fallbackCenter ?? destinationLocation?.location ?? null;
  if (!center) return null;
  const location = await geocodeOrEstimate(map, name, destination, center, index);
  if (!location) return null;
  const distKm = haversine(location.location, center) / 1000;
  // 离群点直接丢弃：大环线跨度再大也不超过 900km（与 geocodeOrEstimate 内部阈值一致）。
  if (distKm > 900) return null;
  return { location, distKm };
}

async function listBrokenPlaces(): Promise<Place[]> {
  const entries = await readdir(PLACES_DIR);
  const places: Place[] = [];
  for (const entry of entries) {
    if (!entry.startsWith("place_") || !entry.endsWith(".json")) continue;
    const raw = await readFile(path.join(PLACES_DIR, entry), "utf8");
    const data = JSON.parse(raw) as Place;
    const address = data.address ?? "";
    if (data.locationStatus === "estimated" && address.includes("位置待核实")) places.push(data);
  }
  return places;
}

async function main() {
  const broken = await listBrokenPlaces();
  if (!broken.length) {
    console.log("没有发现需要重新富集的破损 place 文件，脚本无需执行。");
    return;
  }
  // 按 destination + name 去重，避免对同一地点重复 Nominatim 调用。
  const uniqueTargets = new Map<string, { destination: string; name: string }>();
  for (const place of broken) {
    const destination = (place.address ?? "").replace(/（位置待核实）/g, "").trim();
    const key = `${destination}|${place.name}`;
    if (!uniqueTargets.has(key)) uniqueTargets.set(key, { destination, name: place.name });
  }
  console.log(`共 ${broken.length} 个破损 place，去重后 ${uniqueTargets.size} 个待重试目标。`);

  const map = new OsmMapProvider();
  const updates = new Map<string, { location: { lat: number; lng: number }; address: string; verified: boolean }>();

  let index = 0;
  for (const { destination, name } of uniqueTargets.values()) {
    index++;
    try {
      const result = await regeocode(destination, name, map, index);
      if (!result) {
        console.log(`[${index}/${uniqueTargets.size}] ${destination} → ${name}: 无有效结果，保持原样。`);
        continue;
      }
      updates.set(`${destination}|${name}`, result.location);
      const lat = result.location.location.lat.toFixed(4);
      const lng = result.location.location.lng.toFixed(4);
      console.log(`[${index}/${uniqueTargets.size}] ${destination} → ${name}: (${lat}, ${lng}) verified=${result.location.verified} 距中心≈${Math.round(result.distKm)}km`);
    } catch (error) {
      console.warn(`[${index}/${uniqueTargets.size}] ${destination} → ${name}: 调用失败 ${error instanceof Error ? error.message : error}`);
    }
  }

  // 把修复写回 disk。
  let patched = 0;
  for (const entry of broken) {
    const destination = (entry.address ?? "").replace(/（位置待核实）/g, "").trim();
    const updated = updates.get(`${destination}|${entry.name}`);
    if (!updated) continue;
    const next: Place = {
      ...entry,
      location: { lat: updated.location.lat, lng: updated.location.lng },
      locationStatus: updated.verified ? "verified" : "estimated",
      address: updated.address,
    };
    await writeFile(path.join(PLACES_DIR, `${entry.id}.json`), JSON.stringify(next, null, 2), "utf8");
    patched++;
  }
  console.log(`\n完成：总共重新富集 ${updates.size} 个地点，回写 place 文件 ${patched} 个。`);
  if (updates.size === 0) console.log("\n提示：若所有目标都没有结果，请检查 NOMINATIM_BASE_URL 是否可达，或单独挑选地域关键词明显的地点人工校对。");
}

main().catch((error) => {
  console.error("脚本异常：", error);
  process.exit(1);
});
