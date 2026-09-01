/**
 * 一次性清扫脚本：修复 fix-trip-places 漏网的内联离群坐标。
 *
 * 背景：fix-trip-places.mts 只处理"落在珠三角/重庆框内"或 locationStatus=estimated 的内联 place，
 * 导致"verified 但坐标在云南/四川"的历史坏数据漏网（如 trip_f2d686ae 的
 * 喀纳斯景区→云南屏边 23.0,103.7 / 禾木村→四川凉山 28.5,102.8）。
 *
 * 本脚本用更通用的判据：内联坐标偏离本行程坐标中位数 >800km 即视为离群，
 * 依次用磁盘 place（id→name→去后缀名）匹配替换，无匹配则现场 geocode（900km 校验）。
 *
 * 运行：/Users/felix/.workbuddy/binaries/node/versions/22.22.2-2/bin/node --env-file=.env ./node_modules/vite-node/vite-node.mjs -c vitest.config.ts scripts/fix-trip-leftovers.mts
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Place, TripBundle } from "../src/lib/domain";
import { haversine } from "../src/lib/utils";
import { geocodeOrEstimate, matchRouteRegion, OsmMapProvider } from "../src/server/providers/map";

const PLACES_DIR = path.resolve(process.cwd(), "data/places");
const TRIPS_DIR = path.resolve(process.cwd(), "data/trips");

const SUFFIXES = ["风景名胜区", "国家地质公园", "国家湿地公园", "旅游风景区", "地质公园", "自然保护区", "景区", "观景台", "观景平台", "森林公园", "观景"];
function normalize(name: string) {
  let n = name;
  for (const s of SUFFIXES) {
    if (n.endsWith(s)) { n = n.slice(0, -s.length); break; }
  }
  return n;
}

function distKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  return haversine(a, b) / 1000;
}

async function main() {
  const placeFiles = (await readdir(PLACES_DIR)).filter((f) => f.startsWith("place_") && f.endsWith(".json"));
  const byId = new Map<string, Place>();
  const byName = new Map<string, Place>();
  for (const file of placeFiles) {
    const place = JSON.parse(await readFile(path.join(PLACES_DIR, file), "utf8")) as Place;
    if (!place.location?.lat || !place.location?.lng) continue;
    byId.set(place.id, place);
    byName.set(place.name, place);
    byName.set(normalize(place.name), place);
  }
  console.log(`磁盘 place 索引: ${byId.size} 个`);

  const map = new OsmMapProvider();
  const tripFiles = (await readdir(TRIPS_DIR)).filter((f) => f.endsWith(".json"));
  let totalFixed = 0;
  let totalGeocoded = 0;

  for (const file of tripFiles) {
    const filePath = path.join(TRIPS_DIR, file);
    const bundle = JSON.parse(await readFile(filePath, "utf8")) as TripBundle;
    const allPoints: Array<{ lat: number; lng: number }> = [];
    for (const plan of bundle.plans) {
      for (const day of plan.days) {
        for (const activity of day.activities) {
          const loc = activity.place?.location;
          if (loc?.lat && loc?.lng) allPoints.push(loc);
        }
      }
    }
    if (allPoints.length < 3) continue;
    const sortedLat = [...allPoints].map((p) => p.lat).sort((a, b) => a - b);
    const sortedLng = [...allPoints].map((p) => p.lng).sort((a, b) => a - b);
    const median = {
      lat: sortedLat[Math.floor(sortedLat.length / 2)],
      lng: sortedLng[Math.floor(sortedLng.length / 2)],
    };

    let fixed = 0;
    for (const plan of bundle.plans) {
      for (const day of plan.days) {
        for (const activity of day.activities) {
          const place = activity.place;
          if (!place?.location?.lat || !place?.location?.lng) continue;
          if (distKm(place.location, median) <= 800) continue; // 未离群
          const destination = bundle.request?.destination ?? "";
          const src = byId.get(place.id) ?? byName.get(place.name) ?? byName.get(normalize(place.name));
          if (src) {
            place.location = { lat: src.location.lat, lng: src.location.lng };
            place.locationStatus = src.locationStatus;
            place.address = src.address;
            fixed++;
            console.log(`  [disk] ${file.slice(0, 16)}: ${place.name} → (${src.location.lat.toFixed(4)}, ${src.location.lng.toFixed(4)})`);
            continue;
          }
          const center = matchRouteRegion(destination) ?? (await map.geocodeDestination(destination))?.location ?? null;
          if (!center) continue;
          const result = await geocodeOrEstimate(map, place.name, destination || "中国", center, 0);
          if (result && distKm(result.location, center) <= 900) {
            place.location = { lat: result.location.lat, lng: result.location.lng };
            place.locationStatus = result.verified ? "verified" : "estimated";
            place.address = result.address;
            fixed++;
            totalGeocoded++;
            console.log(`  [geocode] ${file.slice(0, 16)}: ${place.name} → (${result.location.lat.toFixed(4)}, ${result.location.lng.toFixed(4)})`);
          } else {
            console.log(`  [skip] ${file.slice(0, 16)}: ${place.name} 无有效结果，保留原样`);
          }
        }
      }
    }
    if (fixed) {
      await writeFile(filePath, JSON.stringify(bundle, null, 2), "utf8");
      totalFixed += fixed;
      console.log(`${file.slice(0, 16)}: 修复 ${fixed} 处`);
    }
  }
  console.log(`\n完成：共修复 ${totalFixed} 处（其中现场 geocode ${totalGeocoded} 处）。`);
}

main().catch((error) => {
  console.error("[fix-trip-leftovers] 失败:", error);
  process.exit(1);
});
