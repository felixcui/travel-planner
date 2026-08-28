import { describe, expect, it } from "vitest";
import type { AgentSession, TripBundle } from "@/lib/domain";
import { extractTripBriefFallback, interpretPlanChangeFallback, TravelAgentService } from "./agent";

class MemorySessions {
  values = new Map<string, AgentSession>();
  async get(id: string) { return this.values.get(id) ?? null; }
  async save(session: AgentSession) { this.values.set(session.id, session); return session; }
}

class MemoryTrips {
  values = new Map<string, TripBundle>();
  async get(id: string) { return this.values.get(id) ?? null; }
  async save(bundle: TripBundle) { this.values.set(bundle.id, bundle); return bundle; }
}

describe("TravelAgentService", () => {
  it("从一句自然语言中提取自驾需求", () => {
    const brief = extractTripBriefFallback("想去川西玩5天，2大1小，孩子8岁，节奏轻松，喜欢自然风光，驾驶不超过4小时");
    expect(brief).toMatchObject({ destination: "川西", days: 5, adults: 2, children: 1, childAges: [8], pace: "relaxed", maxDriveHours: 4 });
    expect(brief.interests).toContain("自然风光");
    expect(brief.mustGo).toBeUndefined();
  });

  it("儿童年龄缺失时继续追问；补充需求后进入多轮访谈，访谈完才 ready", async () => {
    const sessions = new MemorySessions();
    const service = new TravelAgentService(sessions, new MemoryTrips());
    let session = await service.createSession();
    ({ session } = await service.handleTurn(session.id, { type: "message", message: "去川西玩5天，2大1小，节奏轻松" }));
    expect(session.stage).toBe("collecting");
    expect(session.messages.at(-1)?.content).toContain("孩子");
    ({ session } = await service.handleTurn(session.id, { type: "message", message: "孩子8岁，必去四姑娘山，喜欢自然风光" }));
    expect(session.stage).toBe("collecting");
    expect(session.messages.at(-1)?.content).toContain("不想去");
    expect(session.brief.childAges).toEqual([8]);
    expect(session.brief.mustGo).toContain("四姑娘山");
    ({ session } = await service.handleTurn(session.id, { type: "message", message: "没有" }));
    expect(session.stage).toBe("ready");
  });

  it("开始规划前会先追问必去景点，而不是直接 ready", async () => {
    const sessions = new MemorySessions();
    const service = new TravelAgentService(sessions, new MemoryTrips());
    let session = await service.createSession();
    ({ session } = await service.handleTurn(session.id, { type: "message", message: "去新疆玩10天，北疆大环线，2位成人" }));
    expect(session.stage).toBe("collecting");
    expect(session.messages.at(-1)?.content).toContain("必去");
  });

  it("把常见修改要求限制为结构化操作", () => {
    const plan = {
      id: "plan_1", name: "经典", tagline: "少折返", accent: "vermillion" as const, version: 1, createdAt: "2026-08-07T00:00:00.000Z",
      days: [{ id: "day_1", day: 2, title: "雪山", activities: [], segments: [], stay: "康定", stayReason: "衔接", totalDistanceM: 0, totalDriveS: 0, intensity: "balanced" as const, issues: [] }],
    };
    expect(interpretPlanChangeFallback("第二天轻松一点", plan)).toEqual([{ type: "lighten_day", day: 2 }]);
    expect(interpretPlanChangeFallback("第二天把甲居藏寨换成墨石公园", plan)).toEqual([{ type: "replace_place", day: 2, placeName: "甲居藏寨", replacement: "墨石公园" }]);
  });

  it("确认修改时拒绝覆盖已经变化的方案版本", async () => {
    const sessions = new MemorySessions();
    const trips = new MemoryTrips();
    const plan = { id: "plan_1", name: "经典", tagline: "少折返", accent: "vermillion" as const, version: 2, createdAt: "2026-08-07T00:00:00.000Z", days: [] };
    const trip: TripBundle = {
      schemaVersion: 2, id: "trip_1", request: { destination: "川西", days: 1, adults: 2, children: 0, childAges: [], seniors: 0, pace: "balanced", interests: [], mustGo: [], avoid: [], earliestDeparture: "09:00", latestArrival: "19:30", maxDriveHours: 5, notes: "" },
      plans: [plan], selectedPlanId: plan.id, sourceMode: "demo", revisions: [], createdAt: plan.createdAt, updatedAt: plan.createdAt,
    };
    const session: AgentSession = {
      schemaVersion: 1, id: "session_1", stage: "editing", brief: { destination: "川西", days: 1, confirmedFields: ["destination", "days"] }, interviewQueue: [], messages: [], tripId: trip.id,
      pendingChange: { id: "change_1", planId: plan.id, baseVersion: 1, summary: "精简", affectedDays: [1], operations: [{ type: "lighten_day", day: 1 }], before: { distanceM: 0, driveS: 0, tiringDays: 0, placeCount: 0 }, after: { distanceM: 0, driveS: 0, tiringDays: 0, placeCount: 0 }, proposedPlan: { ...plan, version: 2 }, createdAt: plan.createdAt },
      createdAt: plan.createdAt, updatedAt: plan.createdAt,
    };
    await sessions.save(session); await trips.save(trip);
    await expect(new TravelAgentService(sessions, trips).handleTurn(session.id, { type: "confirm_change" })).rejects.toThrow("已经发生变化");
  });
});
