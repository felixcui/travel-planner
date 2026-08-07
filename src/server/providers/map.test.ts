import { describe, expect, it, vi } from "vitest";
import type { Place } from "@/lib/domain";
import { OsmMapProvider } from "./map";

const knowledge = { summary: "", highlights: [], playTips: [], suggestedDurationMin: 120, suitableFor: [], cautions: [], status: "auto" as const, updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1000).toISOString(), lockedFields: [], sources: [] };

describe("OsmMapProvider", () => {
  it("任一端点坐标为估算时，不把 OSRM 结果标成精确路线", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ routes: [{ distance: 1000, duration: 100, geometry: { coordinates: [[81, 43], [82, 44]] } }] }), { status: 200 }));
    const provider = new OsmMapProvider("https://nominatim.test", "https://osrm.test", "test", request as typeof fetch);
    const from: Place = { id: "a", name: "A", aliases: [], address: "", category: "景点", location: { lat: 43, lng: 81 }, locationStatus: "estimated", knowledge };
    const to: Place = { ...from, id: "b", name: "B", location: { lat: 44, lng: 82 }, locationStatus: "verified" };
    const route = await provider.calculateRoute(from, to);
    expect(route.status).toBe("estimated");
    expect(route.provider).toBe("osrm-estimated-location");
  });
});
