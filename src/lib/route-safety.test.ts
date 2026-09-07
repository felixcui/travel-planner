import { describe, expect, it } from "vitest";
import { PlanSchema, TripRequestSchema } from "./domain";
import { isConcretePlace, requireEndpoints, routeSafety } from "./route-safety";
import { applyDayRules } from "./rules";

const request = TripRequestSchema.parse({ destination: "川西", days: 1, startPoint: "成都", endPoint: "成都" });
const plan = PlanSchema.parse({ id: "plan", name: "轻松", tagline: "", accent: "pine", version: 1, createdAt: "2026-09-07", days: [{ id: "day", day: 1, title: "返程", stay: "成都", totalDriveS: 0, totalDistanceM: 0, intensity: "relaxed", segments: [], activities: [{ id: "activity", type: "place", durationMin: 60, place: { id: "place", name: "折多山", location: { lat: 30, lng: 102 }, knowledge: { summary: "", updatedAt: "2026-09-07", expiresAt: "2026-10-07" } } }] }] });

describe("可执行路线门槛", () => {
  it("拒绝回家等意图作为端点，但接受明确城市和酒店", () => {
    for (const name of ["返程回家", "返回出发地", "当地酒店", "待定", "自由活动"]) expect(isConcretePlace(name)).toBe(false);
    expect(isConcretePlace("成都东站")).toBe(true);
    expect(() => requireEndpoints({ ...request, endPoint: "回家" })).toThrow("结束地点");
    expect(() => requireEndpoints(request)).not.toThrow();
  });
  it("全程汇总不遗漏非当前天的驾驶超限，不能输出可出发", () => {
    const result = routeSafety({ ...plan, days: [plan.days[0], { ...plan.days[0], id: "d2", day: 2, totalDriveS: 10.8 * 3600 }] }, { ...request, days: 2 });
    expect(result.blocked).toBe(true);
    expect(result.message).toContain("第 2 天");
    expect(result.message).not.toContain("可按当前节奏出发");
  });
  it("旧行程中的占位端点和必去遗漏都必须提醒", () => {
    const result = routeSafety({ ...plan, days: [{ ...plan.days[0], stay: "返程回家" }] }, { ...request, mustGo: ["塔公草原"] });
    expect(result.message).toContain("不是明确地点");
    expect(result.message).toContain("必去地点尚未安排");
  });
  it("最后一段到酒店的车程也计入结束时间", () => {
    const segment = { id: "s", fromPlaceId: "origin", toPlaceId: "place", fromName: "成都", toName: "折多山", distanceM: 100, durationS: 3600, status: "exact" as const, provider: "test", calculatedAt: "2026-09-07", geometry: [] };
    const day = { ...plan.days[0], segments: [segment, { ...segment, id: "last", fromPlaceId: "place", toPlaceId: "hotel", durationS: 11 * 3600 }], totalDriveS: 12 * 3600 };
    const result = applyDayRules(day, request);
    expect(result.issues.some((issue) => issue.code === "late_arrival")).toBe(true);
    expect(result.intensity).toBe("not_recommended");
  });
  it("无硬冲突也不声称道路开放和预约已核验", () => {
    const result = routeSafety(plan, request);
    expect(result.blocked).toBe(false);
    expect(result.message).toContain("仍需出发前核对");
  });
});
