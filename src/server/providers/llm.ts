import { z } from "zod";
import { PlanChangeOperationSchema, PlanOutlineSchema, TripBriefDraftSchema } from "@/lib/domain";
import type { PlaceKnowledge, Plan, PlanChangeOperation, PlanOutline, SearchResult, TripBriefDraft, TripRequest } from "@/lib/domain";

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
  })).length(1),
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
  generateOutline(request: TripRequest, feedback?: { outline: PlanOutline; message: string }): Promise<PlanOutline>;
  generatePlans(request: TripRequest): Promise<PlanDraft>;
  structureKnowledge(placeName: string, sources: SearchResult[]): Promise<Omit<PlaceKnowledge, "sources" | "updatedAt" | "expiresAt" | "lockedFields">>;
  extractTripBrief(message: string, current: TripBriefDraft): Promise<TripBriefDraft>;
  interpretPlanChange(message: string, plan: Plan): Promise<PlanChangeOperation[]>;
}

/** 规划期 LLM 顾问：把原启发式规则（时长分配/强度评级/砍景点）交给大模型，物理校验留在代码。 */
export interface DayDurationInput {
  day: number;
  places: Array<{ name: string; category: string; suggestedDurationMin: number; summary: string; suitableFor: string[] }>;
}

export interface DayFactsInput {
  day: number;
  placeNames: string[];
  driveHours: number;
  placeCount: number;
  finishTime: string;
}

export interface RemovalCandidateInput {
  name: string;
  category: string;
  isMustGo: boolean;
  suggestedDurationMin: number;
  position: number;
}

export interface PlanningAdvisor {
  allocateDurations(days: DayDurationInput[], request: TripRequest): Promise<Array<{ day: number; durations: Record<string, number> }>>;
  evaluateDays(days: DayFactsInput[], request: TripRequest): Promise<Array<{ day: number; intensity: "relaxed" | "balanced" | "tiring" | "not_recommended"; reason: string }>>;
  chooseRemoval(input: { day: number; driveHours: number; maxDriveHours: number; family: boolean; candidates: RemovalCandidateInput[] }): Promise<{ place: string; reason: string }>;
}

const DurationAllocationSchema = z.object({
  days: z.array(z.object({
    day: z.number().int().min(1),
    durations: z.record(z.string(), z.number().int().min(30).max(600)),
  })),
});

const DayEvaluationSchema = z.object({
  days: z.array(z.object({
    day: z.number().int().min(1),
    intensity: z.enum(["relaxed", "balanced", "tiring", "not_recommended"]),
    reason: z.string().min(1).max(200),
  })),
});

const RemovalChoiceSchema = z.object({
  place: z.string().min(1),
  reason: z.string().min(1).max(200),
});

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

  generateOutline(request: TripRequest, feedback?: { outline: PlanOutline; message: string }) {
    const route = [
      request.startPoint ? `第 1 天从出发地「${request.startPoint}」开始` : "",
      request.endPoint ? `最后 1 天以「${request.endPoint}」收尾` : "",
    ].filter(Boolean).join("，");
    const feedbackText = feedback
      ? `\n上一版草案（用户要调整它）：${JSON.stringify(feedback.outline)}\n用户本轮反馈：${feedback.message}\n请基于反馈修订草案，保持未提及部分稳定，输出完整新草案（version 加 1）。`
      : "";
    return this.complete(
      `为以下自驾需求设计一份初步行程草案（只有骨架，不做精确计算）。恰好 ${request.days} 天。${route ? route + "。" : ""}每天 1-3 个真实、知名的地点名；住宿区域要顺路合理。${feedbackText}\n需求：${JSON.stringify(request)}\n输出：{"version":1,"summary":"一句话总览","days":[{"day":1,"title":"","places":[""],"stay":""}],"highlights":["2-4条亮点或取舍"],"notes":"备注"}`,
      PlanOutlineSchema,
    );
  }

  generatePlans(request: TripRequest) {
    const required = request.mustGo.length ? request.mustGo.join("、") : "由你推荐";
    const route = [
      request.startPoint ? `第 1 天必须从出发地「${request.startPoint}」开始（首个景点从${request.startPoint}出发可达）` : "",
      request.endPoint ? `最后 1 天必须以「${request.endPoint}」收尾（住宿选${request.endPoint}，便于结束行程）` : "",
    ].filter(Boolean).join("；");
    return this.complete(
      `为以下需求生成恰好一套自驾方案，恰好 ${request.days} 天。${route ? `路线要求：${route}。` : ""}\n需求：${JSON.stringify(request)}\n必去：${required}\n每一天 places 只放真实、可在地图检索的地点名称，1-3个；stay 是当晚住宿区域。输出：{"plans":[{"name":"","tagline":"","days":[{"title":"","places":[""],"stay":"","stayReason":""}]}]}`,
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

  allocateDurations(days: DayDurationInput[], request: TripRequest) {
    return this.complete(
      `为自驾行程的每一天分配各景点游玩时长（分钟）。参考每个景点的类型、简介、建议时长和适合人群，结合出行人结构（成人 ${request.adults}、儿童 ${request.children} 位${request.childAges.length ? `（${request.childAges.join("、")} 岁）` : ""}、老人 ${request.seniors} 位）与节奏偏好（${request.pace}）。有儿童或老人时倾向缩短单个景点时长、增加休息；同一天多个景点时要考虑总时长可完成。只能在 30-600 分钟之间取整数值。\n行程：${JSON.stringify(days)}\n输出：{"days":[{"day":1,"durations":{"景点名":120}}]}，durations 必须覆盖该天每一个景点名，不得新增或遗漏。`,
      DurationAllocationSchema,
    ).then((result) => result.days);
  }

  evaluateDays(days: DayFactsInput[], request: TripRequest) {
    return this.complete(
      `基于以下真实物理数据（车程、景点数、结束时间均已由代码计算，不可更改）评估每一天的强度等级。评估要考虑出行人结构（成人 ${request.adults}、儿童 ${request.children} 位${request.childAges.length ? `（${request.childAges.join("、")} 岁）` : ""}、老人 ${request.seniors} 位）和每日驾驶上限 ${request.maxDriveHours} 小时：带幼童或老人时同样驾驶时长应评更高强度。判断标准是“这天的节奏对这家人是否舒适”。\n注意：驾驶超过 ${request.maxDriveHours} 小时上限或晚于 ${request.latestArrival} 结束的日子已由代码判定为 not_recommended，你只需要对没有超限的日子给出 relaxed/balanced/tiring 的软判断（若你判断确实过于劳累也可给 not_recommended 并说明理由）。\n每天数据：${JSON.stringify(days)}\n输出：{"days":[{"day":1,"intensity":"balanced","reason":"简短理由"}]}，必须覆盖每一个给出的天。`,
      DayEvaluationSchema,
    ).then((result) => result.days);
  }

  chooseRemoval(input: { day: number; driveHours: number; maxDriveHours: number; family: boolean; candidates: RemovalCandidateInput[] }) {
    return this.complete(
      `这天自驾行程超出限制（驾驶 ${input.driveHours.toFixed(1)} 小时 / 上限 ${input.maxDriveHours} 小时${input.family ? "，且同行有儿童或老人" : ""}），必须从以下候选景点中移除一个来减负。综合可玩性、类别重复度（同类景点优先移除）、位置（行程中段通常更耗时）、是否必去（必去不可选）来决定移除哪个，并给出面向用户的理由。\n候选：${JSON.stringify(input.candidates)}\n输出：{"place":"要移除的景点名","reason":"给用户看的简短理由"}，place 必须是候选之一且不是必去景点。`,
      RemovalChoiceSchema,
    );
  }
}

export function createLlmProvider(): LlmProvider | null {
  return process.env.GLM_API_KEY ? new GlmChatProvider() : null;
}

export function createPlanningAdvisor(): PlanningAdvisor | null {
  return process.env.GLM_API_KEY ? new GlmChatProvider() : null;
}
