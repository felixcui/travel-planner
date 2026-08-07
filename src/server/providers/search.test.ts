import { describe, expect, it, vi } from "vitest";
import { TavilySearchProvider } from "./search";

describe("TavilySearchProvider", () => {
  it("将 Tavily 字段归一化并隐藏供应商结构", async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ results: [{ title: "夏塔旅游区", url: "https://example.com/xiata", content: "雪山与古道", score: 0.91 }] }), { status: 200 }));
    const provider = new TavilySearchProvider("tvly-test", "https://api.tavily.test", "", request as typeof fetch);
    const results = await provider.search("夏塔旅游区");
    expect(results).toEqual([{ title: "夏塔旅游区", url: "https://example.com/xiata", snippet: "雪山与古道", score: 0.91, publishedAt: undefined, rawContent: undefined, provider: "tavily" }]);
    const init = request.mock.calls[0][1];
    expect(init).toBeDefined();
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({ country: "china", search_depth: "basic", max_results: 5, include_answer: false });
  });

  it("忽略无效链接结果", () => {
    const provider = new TavilySearchProvider("test");
    expect(provider.normalizeResult({ title: "bad", url: "not a url" })).toBeNull();
  });
});
