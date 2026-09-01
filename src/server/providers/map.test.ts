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

  it("目的地编码对环线类目的地走人工核实区域中心（“新疆北疆大环线”→乌鲁木齐，不再经 Nominatim）", async () => {
    // 真实事故：Nominatim 把“新疆北疆大环线”匹配成重庆道路“环线”（距离 685km 合法，
    // 但与查询词仅共享“环”“线”二字）。字符重叠校验能拒绝它，但更稳的做法是
    // 环线类目的地直接查人工核实的区域中心表（最长前缀命中“新疆北疆大环线”→乌鲁木齐）。
    const request = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    const provider = new OsmMapProvider("https://nominatim.test", "https://osrm.test", "test", request as typeof fetch);
    const result = await provider.geocodeDestination("新疆北疆大环线");
    expect(result?.location).toMatchObject({ lat: 43.83, lng: 87.62 });
    expect(result?.verified).toBe(true);
    expect(request).not.toHaveBeenCalled();
  }, 20000);

  it("环线类目的地不被“重庆地铁环线”欺骗（人工核实区域中心直接短路，不再依赖 Nominatim）", async () => {
    // 真实事故：Nominatim 对“北疆大环线”返回重庆地铁环线（lat 29.59, lon 106.58），
    // 老逻辑 bigram 1/4=25% 恰过阈值放行，导致所有北疆景点围绕重庆展开。
    // 新逻辑：环线类目的地先查人工核实的区域中心表（乌鲁木齐），根本不发起 Nominatim 请求。
    const seen: string[] = [];
    const request = vi.fn(async (url: URL) => {
      const q = url.searchParams.get("q") ?? "";
      seen.push(q);
      if (q === "北疆大环线") return new Response(JSON.stringify([{ lat: "29.5884", lon: "106.5767", display_name: "环线, 朝天门大桥下层, 江北城街道, 两江新区, 重庆市" }]), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 });
    });
    const provider = new OsmMapProvider("https://nominatim.test", "https://osrm.test", "test", request as typeof fetch);
    const result = await provider.geocodeDestination("北疆大环线");
    expect(result?.location).toMatchObject({ lat: 43.83, lng: 87.62 }); // 人工核实的乌鲁木齐中心
    expect(result?.verified).toBe(true);
    expect(request).not.toHaveBeenCalled(); // 未发起任何 Nominatim 请求
  }, 20000);

  it("裸“北疆大环线”不被黑龙江“北疆乡”欺骗（剥后缀到“北疆”后 bigram 100% 命中乡镇名）", async () => {
    // 真实事故（重新生成 trip 时发现）：剥后缀后“北疆”被 Nominatim 匹配到
    // “北疆乡, 呼玛县, 大兴安岭地区, 黑龙江省”（lat 51.04, lng 126.09），
    // 2 字查询要求 bigram 100% 命中——“北疆”恰好是“北疆乡”的前缀，校验通过，
    // 导致整条行程所有景点被框死在东北黑河一带。
    // 新逻辑：区域中心表直接命中，跳过整个 Nominatim 候选链。
    const request = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    const provider = new OsmMapProvider("https://nominatim.test", "https://osrm.test", "test", request as typeof fetch);
    const result = await provider.geocodeDestination("北疆大环线");
    expect(result?.location).toMatchObject({ lat: 43.83, lng: 87.62 });
    expect(result?.address).toBe("北疆大环线");
    expect(request).not.toHaveBeenCalled();
  }, 20000);

  it("目的地编码误匹配到香港同音字面地址时（如“青甘”→香港青嶼幹線），直接走人工核实区域中心", async () => {
    // 真实事故：Nominatim 对“青甘”返回香港青嶼幹線訪客中心（lat 22.36, lng 114.08），
    // 老逻辑因 candidate.length<4 短路 bigramOverlap 校验，把香港误结果当成“青甘大环线”的目的地中心，
    // 进而让所有青甘景点被 viewbox 框死在珠三角。
    // 新逻辑：区域中心表命中“青甘大环线”→西宁附近，绝不发起 Nominatim 请求。
    const request = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    const provider = new OsmMapProvider("https://nominatim.test", "https://osrm.test", "test", request as typeof fetch);
    const result = await provider.geocodeDestination("青甘大环线");
    expect(result?.location).toMatchObject({ lat: 36.623, lng: 101.78 }); // 西宁
    expect(result?.verified).toBe(true);
    expect(request).not.toHaveBeenCalled();
  }, 20000);

  it("目的地编码结果在可信范围内且语义匹配时直接采用，不重试", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify([{ lat: "43.8244", lon: "87.6139", display_name: "乌鲁木齐市, 新疆维吾尔自治区" }]), { status: 200 }));
    const provider = new OsmMapProvider("https://nominatim.test", "https://osrm.test", "test", request as typeof fetch);
    const result = await provider.geocodeDestination("乌鲁木齐");
    expect(result?.location).toMatchObject({ lat: 43.8244, lng: 87.6139 });
    expect(request).toHaveBeenCalledTimes(1);
  }, 20000);
});
