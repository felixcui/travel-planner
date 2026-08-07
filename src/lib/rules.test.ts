import { describe, expect, it } from "vitest";
import type { DayPlan, TripRequest } from "./domain";
import { applyDayRules } from "./rules";
import { deriveIntensity, formatHours, haversine } from "./utils";

const request: TripRequest = {
  destination: "新疆伊犁", days: 3, adults: 2, children: 2, childAges: [8, 10], seniors: 0, pace: "balanced", interests: [], mustGo: [], avoid: [],
  earliestDeparture: "09:00", latestArrival: "19:30", maxDriveHours: 5, notes: "",
};

describe("行程规则", () => {
  it("按家庭约束识别高强度驾驶", () => {
    expect(deriveIntensity(4.6 * 3600, 2, request)).toBe("tiring");
    expect(deriveIntensity(6 * 3600, 1, request)).toBe("not_recommended");
  });

  it("为超出驾驶上限的日期生成问题", () => {
    const day: DayPlan = { id: "d1", day: 1, title: "测试", activities: [], segments: [], stay: "伊宁", stayReason: "测试", totalDistanceM: 500_000, totalDriveS: 6 * 3600, intensity: "relaxed", issues: [] };
    const result = applyDayRules(day, request);
    expect(result.intensity).toBe("not_recommended");
    expect(result.issues.some((issue) => issue.code === "drive_limit")).toBe(true);
  });

  it("跨过午夜时仍能识别晚于最晚结束时间", () => {
    const day: DayPlan = { id: "d2", day: 2, title: "超长游览", activities: [], segments: [], stay: "昭苏", stayReason: "测试", totalDistanceM: 0, totalDriveS: 0, intensity: "relaxed", issues: [] };
    day.activities = Array.from({ length: 3 }, (_, index) => ({
      id: `a${index}`, type: "place", startTime: "", endTime: "", durationMin: 300, note: "",
      place: { id: `p${index}`, name: `景点${index}`, aliases: [], address: "", category: "景点", location: { lat: 43, lng: 81 }, locationStatus: "verified", knowledge: { summary: "", highlights: [], playTips: [], suggestedDurationMin: 300, suitableFor: [], cautions: [], status: "auto", updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1000).toISOString(), lockedFields: [], sources: [] } },
    }));
    const result = applyDayRules(day, request);
    expect(result.issues.some((issue) => issue.code === "late_arrival")).toBe(true);
    expect(result.intensity).toBe("not_recommended");
  });

  it("统一格式化卡片小时并计算直线距离", () => {
    expect(formatHours(5400)).toBe("1.5h");
    expect(haversine({ lat: 39.9, lng: 116.4 }, { lat: 31.2, lng: 121.5 })).toBeGreaterThan(1_000_000);
  });
});
