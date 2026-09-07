import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ generatePlans: vi.fn(), geocode: vi.fn(), save: vi.fn(async (value: unknown) => value) }));
vi.mock("../providers/llm", () => ({ createLlmProvider: () => ({ generatePlans: mocks.generatePlans }), createPlanningAdvisor: () => null }));
vi.mock("../repositories/files", () => ({ FilePlaceRepository: class { findByName = async () => null; save = mocks.save; } }));
vi.mock("../providers/map", () => ({ OsmMapProvider: class { geocodeDestination = async () => ({ location: { lat: 30, lng: 102 } }); }, geocodeOrEstimate: mocks.geocode }));
import { generateTrip } from "./planning";
const request = { destination: "川西", days: 1, startPoint: "成都", endPoint: "成都" };
beforeEach(() => { mocks.generatePlans.mockReset(); mocks.geocode.mockReset(); mocks.save.mockClear(); });
describe("详细生成的地点门槛", () => {
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
