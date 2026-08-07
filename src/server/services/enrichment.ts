import type { PlaceKnowledge, SearchResult, SourceEvidence } from "@/lib/domain";
import { id } from "@/lib/utils";
import { createLlmProvider } from "../providers/llm";
import { createSearchProvider } from "../providers/search";

function isOfficial(result: SearchResult) {
  try {
    const host = new URL(result.url).hostname;
    return host.endsWith(".gov.cn") || host === "gov.cn" || /官网|人民政府|文旅|文化和旅游/.test(result.title);
  } catch {
    return false;
  }
}

export function rankSources(results: SearchResult[]) {
  const deduped = new Map<string, SearchResult>();
  for (const result of results) {
    const key = result.url.replace(/\/$/, "");
    const previous = deduped.get(key);
    if (!previous || result.score > previous.score) deduped.set(key, result);
  }
  return [...deduped.values()].sort((a, b) => Number(isOfficial(b)) - Number(isOfficial(a)) || b.score - a.score);
}

function fallbackKnowledge(placeName: string, sources: SearchResult[]): Omit<PlaceKnowledge, "sources" | "updatedAt" | "expiresAt" | "lockedFields"> {
  const snippets = sources.map((source) => source.snippet).filter(Boolean);
  return {
    summary: snippets[0]?.slice(0, 180) || `${placeName}的详细资料暂未完成联网核验，可先加入路线，出发前请查看景区官方信息。`,
    highlights: snippets.slice(0, 3).map((snippet) => snippet.slice(0, 72)),
    playTips: ["先确定核心体验，再根据现场客流调整游览顺序", "预留拍照、休息和接驳时间"],
    suggestedDurationMin: 150,
    suitableFor: ["家庭出游", "自驾游客"],
    cautions: ["开放时间、预约及票务信息请以景区官方渠道为准"],
    status: "needs_review",
  };
}

export async function enrichKnowledge(placeName: string): Promise<PlaceKnowledge> {
  const search = createSearchProvider();
  const llm = createLlmProvider();
  const now = new Date();
  let results: SearchResult[] = [];
  if (search) {
    try {
      results = await search.search(`${placeName} 官网 景点介绍 开放时间 预约 玩法 儿童 注意事项`, { depth: "basic", maxResults: 5, country: "china" });
      if (results.length < 2) {
        results = [...results, ...(await search.search(`${placeName} 旅游攻略 官方信息`, { depth: "advanced", maxResults: 5, country: "china" }))];
      }
      results = rankSources(results);
      const extracted = await search.extract(results.slice(0, 2).map((result) => result.url), `${placeName} 特点 玩法 开放时间 预约 注意事项`);
      results = results.map((result) => ({ ...result, rawContent: extracted.find((item) => item.url === result.url)?.rawContent }));
    } catch {
      // 搜索失败时保留可用的已有结果，并通过状态提示用户。
    }
  }

  let structured = fallbackKnowledge(placeName, results);
  if (llm && results.length) {
    try {
      structured = await llm.structureKnowledge(placeName, results);
    } catch {
      // 模型结构化失败不阻断路线生成。
    }
  }
  const sources: SourceEvidence[] = results.slice(0, 5).map((result) => ({
    id: id("source"),
    title: result.title,
    url: result.url,
    siteName: (() => { try { return new URL(result.url).hostname; } catch { return "未知来源"; } })(),
    snippet: result.snippet.slice(0, 320),
    score: result.score,
    publishedAt: result.publishedAt,
    retrievedAt: now.toISOString(),
    provider: result.provider,
    supports: ["summary", "highlights", "playTips"],
    official: isOfficial(result),
  }));
  return {
    ...structured,
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 90 * 24 * 3600 * 1000).toISOString(),
    lockedFields: [],
    sources,
  };
}
