import { z } from "zod";
import { PlanChangeOperationSchema, TripBriefDraftSchema } from "@/lib/domain";
import type { PlaceKnowledge, Plan, PlanChangeOperation, SearchResult, TripBriefDraft, TripRequest } from "@/lib/domain";

const PlanDraftSchema = z.object({
  plans: z.array(z.object({
    name: z.string(),
    tagline: z.string(),
    days: z.array(z.object({
      title: z.string(),
      places: z.array(z.string()).min(1).max(4),
      stay: z.string(),
      stayReason: z.string(),
    })),
  })).min(2).max(2),
});
export type PlanDraft = z.infer<typeof PlanDraftSchema>;

const KnowledgeDraftSchema = z.object({
  summary: z.string(),
  highlights: z.array(z.string()),
  playTips: z.array(z.string()),
  suggestedDurationMin: z.number().int().min(30).max(600),
  suitableFor: z.array(z.string()),
  openingHours: z.string().optional(),
  reservation: z.string().optional(),
  cautions: z.array(z.string()),
  needsReview: z.boolean(),
});

export interface LlmProvider {
  generatePlans(request: TripRequest): Promise<PlanDraft>;
  structureKnowledge(placeName: string, sources: SearchResult[]): Promise<Omit<PlaceKnowledge, "sources" | "updatedAt" | "expiresAt" | "lockedFields">>;
  extractTripBrief(message: string, current: TripBriefDraft): Promise<TripBriefDraft>;
  interpretPlanChange(message: string, plan: Plan): Promise<PlanChangeOperation[]>;
}

export class GlmChatProvider implements LlmProvider {
  constructor(
    private readonly apiKey = process.env.GLM_API_KEY ?? "",
    private readonly baseUrl = process.env.GLM_BASE_URL ?? "https://open.bigmodel.cn/api/coding/paas/v4",
    private readonly model = process.env.GLM_MODEL ?? "glm-5.2",
    private readonly request: typeof fetch = fetch,
  ) {}

  private async complete<T>(prompt: string, schema: z.ZodType<T>, repair = true): Promise<T> {
    if (!this.apiKey) throw new Error("GLM_API_KEY 未配置");
    const response = await this.request(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: "你是严谨的中国自驾旅行规划师。只返回合法 JSON，不使用 Markdown。不得编造距离、车程、票价或开放时间。" },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        thinking: { type: "disabled" },
        max_tokens: 8192,
        temperature: 0.25,
      }),
    });
    if (!response.ok) throw new Error(`GLM 调用失败：HTTP ${response.status}`);
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("GLM 未返回内容");
    try {
      return schema.parse(JSON.parse(content));
    } catch (error) {
      if (!repair) throw error;
      return this.complete(`${prompt}\n上次输出未通过结构校验。请严格按要求重新输出完整 JSON。`, schema, false);
    }
  }

  generatePlans(request: TripRequest) {
    const required = request.mustGo.length ? request.mustGo.join("、") : "由你推荐";
    return this.complete(
      `为以下需求生成恰好两套不同的自驾方案，每套恰好 ${request.days} 天。第一套均衡经典，第二套突出兴趣且减少折返。\n需求：${JSON.stringify(request)}\n必去：${required}\n每一天 places 只放真实、可在地图检索的地点名称，1-3个；stay 是当晚住宿区域。输出：{"plans":[{"name":"","tagline":"","days":[{"title":"","places":[""],"stay":"","stayReason":""}]}]}`,
      PlanDraftSchema,
    );
  }

  extractTripBrief(message: string, current: TripBriefDraft) {
    return this.complete(
      `从用户消息中提取中国多日自驾需求，只返回本次明确提到或修正的字段。不要猜目的地、天数或儿童年龄。confirmedFields 必须只列出本次明确出现的字段名。\n已有需求：${JSON.stringify(current)}\n用户消息：${message}\n输出字段可包括 destination、days、adults、children、childAges、seniors、pace(relaxed|balanced|compact)、interests、mustGo、avoid、startPoint、endPoint、earliestDeparture、latestArrival、maxDriveHours、month、notes、confirmedFields。`,
      TripBriefDraftSchema,
    );
  }

  interpretPlanChange(message: string, plan: Plan) {
    return this.complete(
      `把用户对自驾行程的修改要求转换为最少量结构化操作。只允许 add_place、remove_place、replace_place、move_place、update_stay、lighten_day；day 从 1 开始。若不是明确修改请求返回空数组。不得返回行程中不存在的被删除/移动地点。\n当前方案：${JSON.stringify(plan)}\n用户消息：${message}\n输出：{"operations":[]}`,
      z.object({ operations: z.array(PlanChangeOperationSchema) }),
    ).then((result) => result.operations);
  }

  async structureKnowledge(placeName: string, sources: SearchResult[]) {
    const compactSources = sources.slice(0, 5).map(({ title, url, snippet, rawContent }) => ({ title, url, snippet, rawContent: rawContent?.slice(0, 5000) }));
    const result = await this.complete(
      `根据这些网络资料整理“${placeName}”的景点信息。只依据资料；开放时间、预约信息无官方依据时省略并将 needsReview 设为 true。\n资料：${JSON.stringify(compactSources)}\n输出：{"summary":"","highlights":[],"playTips":[],"suggestedDurationMin":120,"suitableFor":[],"openingHours":"","reservation":"","cautions":[],"needsReview":false}`,
      KnowledgeDraftSchema,
    );
    return { ...result, status: result.needsReview ? "needs_review" as const : "auto" as const };
  }
}

export function createLlmProvider(): LlmProvider | null {
  return process.env.GLM_API_KEY ? new GlmChatProvider() : null;
}
