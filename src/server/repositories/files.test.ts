import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TripBundle } from "@/lib/domain";

let testDir = "";

function bundle(id: string, updatedAt: string): TripBundle {
  return {
    schemaVersion: 1,
    id,
    request: {
      destination: "新疆伊犁", days: 1, adults: 2, children: 0, childAges: [], seniors: 0,
      pace: "balanced", interests: ["自然风光"], mustGo: [], avoid: [], earliestDeparture: "09:00",
      latestArrival: "19:30", maxDriveHours: 5, notes: "",
    },
    plans: [{
      id: `plan_${id}`, name: "经典路线", tagline: "轻松游览", accent: "vermillion", version: 1,
      createdAt: updatedAt,
      days: [{ id: `day_${id}`, day: 1, title: "出发", activities: [], segments: [], stay: "昭苏县城", stayReason: "方便游览", totalDistanceM: 0, totalDriveS: 0, intensity: "relaxed", issues: [] }],
    }],
    selectedPlanId: `plan_${id}`,
    sourceMode: "live",
    createdAt: updatedAt,
    updatedAt,
  };
}

afterEach(async () => {
  if (testDir) await rm(testDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  vi.resetModules();
});

describe("FileTripRepository", () => {
  it("保存、读取并按更新时间倒序列出行程", async () => {
    testDir = await mkdtemp(join(tmpdir(), "travel-planner-trips-"));
    process.env.DATA_DIR = testDir;
    vi.resetModules();
    const { FileTripRepository } = await import("./files");
    const repository = new FileTripRepository();

    await repository.save(bundle("trip_old", "2026-08-01T08:00:00.000Z"));
    await repository.save(bundle("trip_new", "2026-08-02T08:00:00.000Z"));

    expect((await repository.get("trip_old"))?.request.destination).toBe("新疆伊犁");
    expect((await repository.list()).map((trip) => trip.id)).toEqual(["trip_new", "trip_old"]);
    expect(await repository.get("missing")).toBeNull();
  });
});
