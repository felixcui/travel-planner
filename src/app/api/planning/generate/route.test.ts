import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TripBundle } from "@/lib/domain";

const { generateTrip, saveTrip } = vi.hoisted(() => ({ generateTrip: vi.fn(), saveTrip: vi.fn() }));
vi.mock("@/server/services/planning", () => ({ generateTrip }));
vi.mock("@/server/repositories/files", () => ({ FileTripRepository: class { save = saveTrip; } }));

import { POST } from "./route";

const generated: TripBundle = {
  schemaVersion: 2,
  id: "trip_generated",
  request: {
    destination: "川西", days: 1, adults: 2, children: 0, childAges: [], seniors: 0,
    pace: "balanced", interests: [], mustGo: [], avoid: [], earliestDeparture: "09:00",
    latestArrival: "19:30", maxDriveHours: 5, notes: "",
  },
  plans: [{
    id: "plan_generated", name: "川西小环线", tagline: "雪山与草原", accent: "vermillion", version: 1,
    createdAt: "2026-08-07T00:00:00.000Z",
    days: [{ id: "day_generated", day: 1, title: "雪山初见", activities: [], segments: [], stay: "康定", stayReason: "方便衔接", totalDistanceM: 0, totalDriveS: 0, intensity: "relaxed", issues: [] }],
  }],
  selectedPlanId: "plan_generated",
  sourceMode: "live",
  revisions: [],
  createdAt: "2026-08-07T00:00:00.000Z",
  updatedAt: "2026-08-07T00:00:00.000Z",
};

beforeEach(() => {
  generateTrip.mockReset();
  saveTrip.mockReset();
});

describe("POST /api/planning/generate", () => {
  it("只在生成成功后保存完整行程并返回结果", async () => {
    generateTrip.mockResolvedValue(generated);
    saveTrip.mockResolvedValue(generated);

    const response = await POST(new Request("http://localhost/api/planning/generate", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(generated.request),
    }));

    expect(response.status).toBe(200);
    expect(saveTrip).toHaveBeenCalledOnce();
    expect(saveTrip).toHaveBeenCalledWith(generated);
    expect(await response.json()).toEqual(generated);
  });

  it("生成失败时不写入行程仓储", async () => {
    generateTrip.mockRejectedValue(new Error("生成失败"));
    const response = await POST(new Request("http://localhost/api/planning/generate", { method: "POST", body: "{}" }));
    expect(response.status).toBe(500);
    expect(saveTrip).not.toHaveBeenCalled();
  });
});
