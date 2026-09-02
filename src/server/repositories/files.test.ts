import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TripBundle } from "@/lib/domain";

let testDir = "";

function bundle(id: string, updatedAt: string): TripBundle {
  return {
    schemaVersion: 2,
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
    revisions: [],
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
  it("保存、读取并按更新时间倒序列出行程", { timeout: 10000 }, async () => {
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

  it("读取 v1 文件时迁移为 v2 并建立初始版本", async () => {
    testDir = await mkdtemp(join(tmpdir(), "travel-planner-migration-"));
    process.env.DATA_DIR = testDir;
    const current = bundle("trip_legacy", "2026-08-01T08:00:00.000Z");
    const legacy = { ...current, schemaVersion: 1, revisions: undefined };
    await mkdir(join(testDir, "trips"), { recursive: true });
    await writeFile(join(testDir, "trips", "trip_legacy.json"), JSON.stringify(legacy), "utf8");
    vi.resetModules();
    const { FileTripRepository } = await import("./files");
    const migrated = await new FileTripRepository().get("trip_legacy");
    expect(migrated?.schemaVersion).toBe(2);
    expect(migrated?.revisions).toHaveLength(1);
    expect(migrated?.revisions[0].source).toBe("generated");
  });

  it("分享快照只保留选中方案并移除会话和版本历史", async () => {
    testDir = await mkdtemp(join(tmpdir(), "travel-planner-share-"));
    process.env.DATA_DIR = testDir;
    vi.resetModules();
    const { FileShareRepository } = await import("./files");
    const repository = new FileShareRepository();
    const value = bundle("trip_private", "2026-08-01T08:00:00.000Z");
    value.agentSessionId = "session_private";
    value.revisions = [{ id: "rev_1", planId: value.plans[0].id, version: 1, source: "generated", summary: "初始", createdAt: value.createdAt, snapshot: value.plans[0] }];
    await repository.save("secret-token", value);
    const shared = await repository.get("secret-token");
    expect(shared?.plans).toHaveLength(1);
    expect(shared?.agentSessionId).toBeUndefined();
    expect(shared?.revisions).toEqual([]);
  });
});
