import type { Coordinate, Place, RouteSegment } from "@/lib/domain";
import { deterministicOffset, haversine, id } from "@/lib/utils";

export interface MapProvider {
  geocode(query: string, region?: string, bias?: Coordinate, options?: { bounded?: boolean; limit?: number; nearestTo?: Coordinate }): Promise<{ location: Coordinate; address: string; verified: boolean } | null>;
  geocodeDestination(query: string): Promise<{ location: Coordinate; address: string; verified: boolean } | null>;
  calculateRoute(from: Place, to: Place): Promise<RouteSegment>;
}

let lastNominatimCall = 0;
const geocodeMemory = new Map<string, { location: Coordinate; address: string; verified: boolean } | null>();

/** 中国大陆质心（粗略）：用于剔除明显跑偏的编码结果 */
const CHINA_CENTER: Coordinate = { lat: 35.5, lng: 104.5 };
/** 目的地编码结果离中国质心的最大可信距离（km）：覆盖喀什/漠河/三亚等边缘城市 */
const MAX_DESTINATION_DISTANCE_KM = 2900;

function distanceKm(a: Coordinate, b: Coordinate) {
  return haversine(a, b) / 1000;
}

/**
 * 环线/线路类目的地的区域中心（人工核实，来自《全国自驾游线路区域中心》维护表）。
 * 这类目的地（青甘大环线/北疆大环线/川西小环线等）没有标准行政区划，
 * Nominatim 常把它们匹配到同字面/同音地址（青甘→香港青嶼幹線、北疆→黑龙江北疆乡、环线→重庆地铁环线），
 * 因此人工核实的区域中心优先级高于 geocodeDestination 的 Nominatim 结果。
 */
export const ROUTE_REGION_FALLBACK: Record<string, Coordinate> = {
  "青甘": { lat: 36.623, lng: 101.78 }, "青甘大": { lat: 36.623, lng: 101.78 }, "青甘大环": { lat: 36.623, lng: 101.78 }, "青甘大环线": { lat: 36.623, lng: 101.78 },
  "北疆": { lat: 43.83, lng: 87.62 }, "北疆大": { lat: 43.83, lng: 87.62 }, "北疆大环": { lat: 43.83, lng: 87.62 }, "北疆大环线": { lat: 43.83, lng: 87.62 },
  "新疆北疆": { lat: 43.83, lng: 87.62 }, "新疆北疆大": { lat: 43.83, lng: 87.62 }, "新疆北疆大环": { lat: 43.83, lng: 87.62 }, "新疆北疆大环线": { lat: 43.83, lng: 87.62 },
  "南疆": { lat: 39.47, lng: 75.99 }, "南疆大": { lat: 39.47, lng: 75.99 }, "南疆大环": { lat: 39.47, lng: 75.99 }, "南疆大环线": { lat: 39.47, lng: 75.99 },
  "川西": { lat: 30.65, lng: 104.07 }, "川西小": { lat: 30.65, lng: 104.07 }, "川西小环": { lat: 30.65, lng: 104.07 }, "川西小环线": { lat: 30.65, lng: 104.07 },
  "甘南": { lat: 34.99, lng: 104.07 }, "甘南大": { lat: 34.99, lng: 104.07 }, "甘南大环": { lat: 34.99, lng: 104.07 }, "甘南大环线": { lat: 34.99, lng: 104.07 },
  "河西走廊": { lat: 38.93, lng: 100.45 },
  "丝绸之路": { lat: 40.14, lng: 94.66 },
};

/** 精确匹配优先，其次最长前缀匹配（“新疆北疆大环线”命中“新疆北疆大环线”而非“北疆”）。 */
export function matchRouteRegion(destination: string): Coordinate | null {
  if (!destination) return null;
  if (ROUTE_REGION_FALLBACK[destination]) return ROUTE_REGION_FALLBACK[destination];
  const keys = Object.keys(ROUTE_REGION_FALLBACK).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (destination.startsWith(key)) return ROUTE_REGION_FALLBACK[key];
  }
  return null;
}

/** 查询词与返回地址的语义重叠：查询词的连续 2 字子串（bigram）出现在地址中的比例。
 *  误匹配特征：“新疆北疆大环线”→重庆道路“环线”，仅零散字符巧合重叠；真匹配必有连续地名片段（如“新疆”“北疆”）。 */
function bigramOverlap(query: string, address: string) {
  if (query.length < 2) return 1;
  const bigrams: string[] = [];
  for (let i = 0; i < query.length - 1; i++) bigrams.push(query.slice(i, i + 2));
  const hit = bigrams.filter((bigram) => address.includes(bigram)).length;
  return hit / bigrams.length;
}

export class OsmMapProvider implements MapProvider {
  constructor(
    private readonly nominatimBase = process.env.NOMINATIM_BASE_URL ?? "https://nominatim.openstreetmap.org",
    private readonly osrmBase = process.env.OSRM_BASE_URL ?? "https://router.project-osrm.org",
    private readonly userAgent = process.env.MAP_USER_AGENT ?? "TravelPlannerMVP/0.1",
    private readonly request: typeof fetch = fetch,
  ) {}

  async geocode(query: string, region = "中国", bias?: Coordinate, options?: { bounded?: boolean; limit?: number; nearestTo?: Coordinate }) {
    const key = `${query}|${region}|${bias ? `${bias.lat.toFixed(2)},${bias.lng.toFixed(2)}` : ""}|${options?.bounded === false ? "unbounded" : ""}|${options?.limit ?? 1}|${options?.nearestTo ? `${options.nearestTo.lat.toFixed(2)},${options.nearestTo.lng.toFixed(2)}` : ""}`;
    if (geocodeMemory.has(key)) return geocodeMemory.get(key) ?? null;
    const delay = Math.max(0, 1050 - (Date.now() - lastNominatimCall));
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    lastNominatimCall = Date.now();
    try {
      const url = new URL("/search", this.nominatimBase);
      url.searchParams.set("q", region && region !== "中国" ? `${query}, ${region}` : query);
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("limit", String(options?.limit ?? 1));
      url.searchParams.set("countrycodes", "cn");
      if (bias) {
        const radius = region.length <= 3 ? 8 : 4;
        url.searchParams.set("viewbox", `${bias.lng - radius},${bias.lat + radius},${bias.lng + radius},${bias.lat - radius}`);
        if (options?.bounded !== false) url.searchParams.set("bounded", "1");
      }
      const response = await this.request(url, { headers: { "User-Agent": this.userAgent, "Accept-Language": "zh-CN" }, signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw new Error(String(response.status));
      const data = (await response.json()) as Array<{ lat: string; lon: string; display_name: string }>;
      let entries = data.map((item) => ({ location: { lat: Number(item.lat), lng: Number(item.lon) }, address: item.display_name, verified: true as const }));
      // 多候选时择优：选离参考点最近的（通名如“魔鬼城”全国多地有同名，取离目的地最近者）
      if (options?.nearestTo && entries.length > 1) {
        entries = [...entries].sort((a, b) => haversine(a.location, options.nearestTo!) - haversine(b.location, options.nearestTo!));
      }
      const result = entries[0] ?? null;
      geocodeMemory.set(key, result);
      return result;
    } catch {
      geocodeMemory.set(key, null);
      return null;
    }
  }

  /**
   * 目的地编码：双重校验（距离 + 字符重叠），失败时依次尝试剥后缀与递减重试。
   * 防御场景：“新疆北疆大环线”被 Nominatim 匹配成重庆道路“环线”——距离仅 685km 拦不住，
   * 但与查询词仅共享“环”“线”两字，字符重叠校验可识别此类误匹配，剥掉“大环线”后以“新疆”收敛。
   *
   * 字符重叠校验对所有长度的查询一视同仁（不再为 length<4 短路）：
   * 短查询（如“青甘”→香港“青嶼幹線”）bigram 几乎不可能命中返回地址，自然被拒；
   * 真匹配（如“新疆”→“新疆维吾尔自治区”）bigram 会命中，至少有 1 个 bigram 命中即 ≥25%。
   */
  async geocodeDestination(query: string): Promise<{ location: Coordinate; address: string; verified: boolean } | null> {
    // 环线/线路类目的地（青甘/北疆/川西等）无标准行政区划，Nominatim 常误匹配到同字面/同音地址
    // （“北疆大环线”→重庆地铁环线、“北疆”→黑龙江呼玛县北疆乡），人工核实的区域中心优先。
    const fallbackCenter = matchRouteRegion(query);
    if (fallbackCenter) {
      return { location: fallbackCenter, address: query, verified: true };
    }
    const stripSuffixes = ["大环线", "环线", "大环", "小环线", "线路", "自驾", "之旅", "行程"];
    const candidates = new Set<string>();
    const base = query.trim();
    candidates.add(base);
    let stripped = base;
    for (const suffix of stripSuffixes) {
      if (stripped.endsWith(suffix)) {
        stripped = stripped.slice(0, stripped.length - suffix.length);
        if (stripped.length >= 2) candidates.add(stripped);
      }
    }
    // 再按长度递减兜底（保留至少 2 字）
    let current = stripped;
    while (current.length > 2) {
      current = current.slice(0, current.length - 2);
      candidates.add(current);
    }
    for (const candidate of candidates) {
      const result = await this.geocode(candidate, "中国");
      if (result) {
        const distanceOk = distanceKm(result.location, CHINA_CENTER) <= MAX_DESTINATION_DISTANCE_KM;
        // 长度 ≥ 4：bigram 至少 50% 命中（“北疆大环线”→重庆“环线”仅 1/4=25% 会被拒）；
        // 长度 2/3：bigram 唯一/极少，要求 100% 命中（即语义 bigram 真出现于地址），
        // 防止“青甘”被香港“青嶼”这种零字符重合的同名误匹配通过。
        const overlapOk = candidate.length >= 4 ? bigramOverlap(candidate, result.address) >= 0.5 : bigramOverlap(candidate, result.address) >= 1;
        if (distanceOk && overlapOk) return result;
      }
    }
    return null;
  }

  async calculateRoute(from: Place, to: Place): Promise<RouteSegment> {
    const base = {
      id: id("segment"),
      fromPlaceId: from.id,
      toPlaceId: to.id,
      fromName: from.name,
      toName: to.name,
      calculatedAt: new Date().toISOString(),
      navigationUrl: `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${from.location.lat}%2C${from.location.lng}%3B${to.location.lat}%2C${to.location.lng}`,
    };
    try {
      const coords = `${from.location.lng},${from.location.lat};${to.location.lng},${to.location.lat}`;
      const response = await this.request(`${this.osrmBase}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(String(response.status));
      const data = (await response.json()) as { routes?: Array<{ distance: number; duration: number; geometry: { coordinates: [number, number][] } }> };
      const route = data.routes?.[0];
      if (!route) throw new Error("NoRoute");
      return {
        ...base,
        distanceM: route.distance,
        durationS: route.duration,
        status: from.locationStatus === "verified" && to.locationStatus === "verified" ? "exact" : "estimated",
        provider: from.locationStatus === "verified" && to.locationStatus === "verified" ? "osrm" : "osrm-estimated-location",
        geometry: route.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
      };
    } catch {
      const direct = haversine(from.location, to.location);
      return {
        ...base,
        distanceM: direct * 1.28,
        durationS: (direct * 1.28) / 15,
        status: "estimated",
        provider: "haversine-estimate",
        geometry: [from.location, to.location],
      };
    }
  }
}

export async function geocodeOrEstimate(provider: MapProvider, name: string, region: string, center: Coordinate, index: number) {
  const candidates = [name];
  // Nominatim 对“景区/风景区/旅游区”等后缀命中率低：逐级剥后缀生成候选（“那拉提旅游风景区”→“那拉提旅游”→“那拉提”）
  const suffixes = ["旅游风景区", "风景名胜区", "旅游区", "风景区", "景区", "观景点", "森林公园", "地质公园", "国家湿地公园"];
  let stripped = name;
  for (const suffix of suffixes) {
    if (stripped.endsWith(suffix)) {
      stripped = stripped.slice(0, stripped.length - suffix.length);
      if (stripped.length >= 2) candidates.push(stripped);
    }
  }
  const unique = [...new Set(candidates)];
  for (const candidate of unique) {
    const result = await provider.geocode(candidate, region, center);
    if (result) return result;
  }
  // viewbox 限死时兜底：全中国自由搜 + 多候选择优（limit=5 中取离目的地最近的）；
  // 结果必须离目的地中心足够近（大环线跨度可达数百公里，阈值取省域尺度 900km），
  // 避免“魔鬼城”这类通名命中全国任意同名点（如山东青岛的魔鬼城）
  for (const candidate of unique) {
    const fallback = await provider.geocode(candidate, "中国", center, { bounded: false, limit: 5, nearestTo: center });
    if (fallback && distanceKm(fallback.location, center) <= 900) return fallback;
  }
  const offset = deterministicOffset(`${region}:${name}`, index);
  return { location: { lat: center.lat + offset.lat, lng: center.lng + offset.lng }, address: `${region}（位置待核实）`, verified: false };
}
