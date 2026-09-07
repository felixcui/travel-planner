import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Place, PlanOutline } from "@/lib/domain";
const mocks = vi.hoisted(() => ({ generatePlans: vi.fn(), geocode: vi.fn(), save: vi.fn(async (value: unknown) => value) }));
vi.mock("../providers/llm", () => ({ createLlmProvider: () => ({ generatePlans: mocks.generatePlans }), createPlanningAdvisor: () => null }));
vi.mock("../repositories/files", () => ({ FilePlaceRepository: class { findByName = async () => null; save = mocks.save; } }));
vi.mock("../providers/map", () => ({ OsmMapProvider: class {
  geocodeDestination = async () => ({ location: { lat: 30, lng: 102 } });
  calculateRoute = async (from: Place, to: Place) => ({ id: `${from.id}-${to.id}`, fromPlaceId: from.id, toPlaceId: to.id, fromName: from.name, toName: to.name, distanceM: 100000, durationS: 20000, status: "exact", provider: "test", calculatedAt: new Date().toISOString(), geometry: [] });
}, geocodeOrEstimate: mocks.geocode }));
vi.mock("./enrichment", () => ({ enrichKnowledge: async () => ({ summary: "测试", highlights: [], playTips: [], suggestedDurationMin: 60, suitableFor: [], cautions: [], status: "auto", updatedAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00.000Z", lockedFields: [], sources: [] }) }));
import { generateTrip } from "./planning";
const request = { destination: "川西", days: 1, startPoint: "成都", endPoint: "成都" };
beforeEach(() => { mocks.generatePlans.mockReset(); mocks.geocode.mockReset(); mocks.save.mockClear(); });
describe("详细生成的地点门槛", () => {
  const outline: PlanOutline = { version: 3, summary: "确认路线", days: [{ day: 1, title: "游览", places: ["折多山", "木格措"], stay: "康定" }, { day: 2, title: "回成都", places: ["泸定桥"], stay: "成都" }], highlights: [], notes: "保留顺序" };
  it("严格沿用确认草案，不重新生成；超限也不删点或替换住宿", async () => {
    mocks.geocode.mockImplementation(async (_map, name: string) => ({ verified: true, address: name, location: { lat: 30, lng: name === "成都" ? 104 : 102 } }));
    const original = structuredClone(outline);
    const trip = await generateTrip({ ...request, days: 2 }, outline);
    expect(mocks.generatePlans).not.toHaveBeenCalled();
    expect(trip.plans).toHaveLength(1);
    expect(trip.plans[0].days.map((day) => ({ day: day.day, title: day.title, places: day.activities.filter((a) => a.type === "place").map((a) => a.place.name), stay: day.stay }))).toEqual(outline.days);
    expect(trip.plans[0].days[0].intensity).toBe("not_recommended");
    expect(trip.plans[0].days[0].issues.some((issue) => issue.code === "outline_preserved")).toBe(true);
    expect(trip.confirmedOutline).toEqual(original);
    expect(trip.sourceOutlineVersion).toBe(3);
    expect(trip.revisions[0].summary).toContain("v3");
    expect(outline).toEqual(original);
  });
  it("需求与草案冲突时要求重新确认，不静默截天或改终点", async () => {
    await expect(generateTrip(request, outline)).rejects.toThrow("天数");
    await expect(generateTrip({ ...request, days: 2, endPoint: "重庆" }, outline)).rejects.toThrow("不会自动替换");
    expect(mocks.generatePlans).not.toHaveBeenCalled();
    expect(mocks.geocode).not.toHaveBeenCalled();
  });
  it("缺少明确终点时在调用模型和地图前追问", async () => {
    await expect(generateTrip({ ...request, endPoint: "返程回家" })).rejects.toThrow("结束地点");
    expect(mocks.generatePlans).not.toHaveBeenCalled();
    expect(mocks.geocode).not.toHaveBeenCalled();
  });
  it("模型把返程写成景点时拒绝查询和保存这个假地点", async () => {
    mocks.generatePlans.mockResolvedValue({ plans: [{ name: "测试", days: [{ places: ["返程回家"], stay: "成都" }] }] });
    await expect(generateTrip(request)).rejects.toThrow("不是明确地点");
    expect(mocks.geocode).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("地理编码只能给出估算坐标时不生成正式路线", async () => {
    mocks.generatePlans.mockResolvedValue({ plans: [{ name: "测试", days: [{ places: ["折多山"], stay: "成都" }] }] });
    mocks.geocode.mockResolvedValue({ verified: false, location: { lat: 30, lng: 102 }, address: "待核实" });
    await expect(generateTrip(request)).rejects.toThrow("本次未生成估算坐标路线");
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
