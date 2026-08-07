import type { SearchOptions, SearchResult } from "@/lib/domain";

export type ExtractResult = { url: string; rawContent: string; provider: string };
export type SearchUsage = { used: number; limit: number; provider: string };

export interface SearchProvider {
  search(query: string, options?: Partial<SearchOptions>): Promise<SearchResult[]>;
  extract(urls: string[], query?: string): Promise<ExtractResult[]>;
  getUsage(): Promise<SearchUsage | null>;
}

type TavilyResult = {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  published_date?: string;
  raw_content?: string;
};

export class TavilySearchProvider implements SearchProvider {
  constructor(
    private readonly apiKey = process.env.TAVILY_API_KEY ?? "",
    private readonly baseUrl = process.env.TAVILY_BASE_URL ?? "https://api.tavily.com",
    private readonly projectId = process.env.TAVILY_PROJECT_ID ?? "",
    private readonly request: typeof fetch = fetch,
  ) {}

  private headers() {
    if (!this.apiKey) throw new Error("TAVILY_API_KEY 未配置");
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      ...(this.projectId ? { "X-Project-ID": this.projectId } : {}),
    };
  }

  normalizeResult(result: TavilyResult): SearchResult | null {
    if (!result.url || !result.title) return null;
    try {
      return {
        title: result.title,
        url: new URL(result.url).toString(),
        snippet: result.content ?? "",
        score: Math.max(0, Math.min(1, result.score ?? 0)),
        publishedAt: result.published_date,
        rawContent: result.raw_content,
        provider: "tavily",
      };
    } catch {
      return null;
    }
  }

  async search(query: string, options: Partial<SearchOptions> = {}) {
    const response = await this.request(`${this.baseUrl}/search`, {
      method: "POST",
      headers: this.headers(),
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        query,
        topic: "general",
        country: options.country ?? "china",
        search_depth: options.depth ?? "basic",
        max_results: options.maxResults ?? 5,
        include_answer: false,
        include_raw_content: false,
        include_domains: options.includeDomains,
        include_usage: true,
      }),
    });
    if (!response.ok) throw new Error(`Tavily 搜索失败：HTTP ${response.status}`);
    const data = (await response.json()) as { results?: TavilyResult[] };
    return (data.results ?? []).map((result) => this.normalizeResult(result)).filter((result): result is SearchResult => Boolean(result));
  }

  async extract(urls: string[], query = "景点特点、玩法、开放时间、预约与注意事项") {
    if (!urls.length) return [];
    const response = await this.request(`${this.baseUrl}/extract`, {
      method: "POST",
      headers: this.headers(),
      signal: AbortSignal.timeout(25_000),
      body: JSON.stringify({ urls: urls.slice(0, 2), query, extract_depth: "basic", format: "markdown", chunks_per_source: 3 }),
    });
    if (!response.ok) throw new Error(`Tavily 正文提取失败：HTTP ${response.status}`);
    const data = (await response.json()) as { results?: Array<{ url?: string; raw_content?: string }> };
    return (data.results ?? [])
      .filter((item): item is { url: string; raw_content: string } => Boolean(item.url && item.raw_content))
      .map((item) => ({ url: item.url, rawContent: item.raw_content, provider: "tavily" }));
  }

  async getUsage() {
    try {
      const response = await this.request(`${this.baseUrl}/usage`, { headers: this.headers(), signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return null;
      const data = (await response.json()) as { key?: { usage?: number; limit?: number }; account?: { plan_usage?: number; plan_limit?: number } };
      return {
        used: data.key?.usage ?? data.account?.plan_usage ?? 0,
        limit: data.key?.limit ?? data.account?.plan_limit ?? 0,
        provider: "tavily",
      };
    } catch {
      return null;
    }
  }
}

export function createSearchProvider(): SearchProvider | null {
  if ((process.env.SEARCH_PROVIDER ?? "tavily") === "tavily" && process.env.TAVILY_API_KEY) return new TavilySearchProvider();
  return null;
}
