import { describe, expect, it } from "vitest";
import { rankSources } from "./enrichment";

describe("来源排序", () => {
  it("官方来源优先于高分普通来源并按 URL 去重", () => {
    const ranked = rankSources([
      { title: "游记", url: "https://travel.example.com/a", snippet: "", score: 0.99, provider: "test" },
      { title: "某地文化和旅游局", url: "https://wlt.example.gov.cn/info", snippet: "", score: 0.65, provider: "test" },
      { title: "重复游记", url: "https://travel.example.com/a", snippet: "", score: 0.5, provider: "test" },
    ]);
    expect(ranked[0].url).toContain("gov.cn");
    expect(ranked).toHaveLength(2);
  });
});
