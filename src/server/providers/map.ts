import type { Coordinate, Place, RouteSegment } from "@/lib/domain";
import { deterministicOffset, haversine, id } from "@/lib/utils";

export interface MapProvider {
  geocode(query: string, region?: string, bias?: Coordinate): Promise<{ location: Coordinate; address: string; verified: boolean } | null>;
  calculateRoute(from: Place, to: Place): Promise<RouteSegment>;
}

let lastNominatimCall = 0;
const geocodeMemory = new Map<string, { location: Coordinate; address: string; verified: boolean } | null>();

export class OsmMapProvider implements MapProvider {
  constructor(
    private readonly nominatimBase = process.env.NOMINATIM_BASE_URL ?? "https://nominatim.openstreetmap.org",
    private readonly osrmBase = process.env.OSRM_BASE_URL ?? "https://router.project-osrm.org",
    private readonly userAgent = process.env.MAP_USER_AGENT ?? "TravelPlannerMVP/0.1",
    private readonly request: typeof fetch = fetch,
  ) {}

  async geocode(query: string, region = "中国", bias?: Coordinate) {
    const key = `${query}|${region}|${bias ? `${bias.lat.toFixed(2)},${bias.lng.toFixed(2)}` : ""}`;
    if (geocodeMemory.has(key)) return geocodeMemory.get(key) ?? null;
    const delay = Math.max(0, 1050 - (Date.now() - lastNominatimCall));
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    lastNominatimCall = Date.now();
    try {
      const url = new URL("/search", this.nominatimBase);
      url.searchParams.set("q", region && region !== "中国" ? `${query}, ${region}` : query);
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("limit", "1");
      url.searchParams.set("countrycodes", "cn");
      if (bias) {
        const radius = region.length <= 3 ? 8 : 4;
        url.searchParams.set("viewbox", `${bias.lng - radius},${bias.lat + radius},${bias.lng + radius},${bias.lat - radius}`);
        url.searchParams.set("bounded", "1");
      }
      const response = await this.request(url, { headers: { "User-Agent": this.userAgent, "Accept-Language": "zh-CN" }, signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw new Error(String(response.status));
      const data = (await response.json()) as Array<{ lat: string; lon: string; display_name: string }>;
      const first = data[0];
      const result = first ? { location: { lat: Number(first.lat), lng: Number(first.lon) }, address: first.display_name, verified: true } : null;
      geocodeMemory.set(key, result);
      return result;
    } catch {
      geocodeMemory.set(key, null);
      return null;
    }
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
  if (name.includes("旅游区")) candidates.push(name.replace("旅游区", "景区"));
  if (name.includes("观景点")) candidates.push(name.replace("观景点", ""));
  if (name.includes("风景名胜区")) candidates.push(name.replace("风景名胜区", "景区"));
  for (const candidate of [...new Set(candidates)]) {
    const result = await provider.geocode(candidate, region, center);
    if (result) return result;
  }
  const offset = deterministicOffset(`${region}:${name}`, index);
  return { location: { lat: center.lat + offset.lat, lng: center.lng + offset.lng }, address: `${region}（位置待核实）`, verified: false };
}
