/**
 * pi 对话编排器（Phase 2）：
 * 用 pi-agent-core 的 agent loop 替代手写 stage 状态机的「判断」部分。
 * - 判断在 LLM：问什么、何时收尾、何时生成、修改意图如何结构化 —— 由模型在工具循环里自主决策；
 * - 执行在代码：工具内部做校验、调用 planning / previewChange 等确定性管线；
 * - 语义契约不变：stage 变为工具调用的副作用，NDJSON 事件、AgentSession 结构照旧；
 * - 降级设计：GLM 不可用或循环失败时返回 null，调用方回退到原有规则路径（正则兜底）。
 */
import type { AgentMessage as PiAgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import { runAgentLoop } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import type { Static } from "@mariozechner/pi-ai";
import type { Model } from "@mariozechner/pi-ai";
import type { AgentMessage, AgentSession, Plan, PlanChangeOperation, PlanChangeSet, TripBriefDraft, TripBundle, TripRequest } from "@/lib/domain";
import { PlanChangeOperationSchema } from "@/lib/domain";
import { mergeBrief, missingFields, toRequest } from "./brief-utils";

export interface PiTurnDeps {
  /** 生成两套候选方案（确定性管线：地图、强度校验、知识库） */
  generateTrip: (request: TripRequest) => Promise<TripBundle>;
  /** 计算修改预览（确定性执行：替换/增删/移动 + recalculate） */
  previewChange: (bundle: TripBundle, operations: PlanChangeOperation[]) => Promise<PlanChangeSet>;
  /** 进度事件，映射到 NDJSON progress */
  onProgress: (message: string) => void;
}

export interface PiTurnOutcome {
  /** 本轮结束后的需求档案（可能已被 update_brief 修改） */
  brief: TripBriefDraft;
  /** 面向用户的助手消息（comparison / change_preview 的 content 由调用方合成） */
  assistant: { content: string; kind: AgentMessage["kind"]; quickReplies: string[] };
  /** stage 迁移（工具副作用）；undefined 表示维持现状 */
  stage?: AgentSession["stage"];
  /** generate_plans 工具的产物（由调用方负责持久化并 emit trip） */
  trip?: TripBundle;
  /** request_change 工具的产物（由调用方挂到 session.pendingChange） */
  pendingChange?: PlanChangeSet;
}

export interface PiConversationRunner {
  run(session: AgentSession, userText: string, bundle: TripBundle | null, deps: PiTurnDeps): Promise<PiTurnOutcome | null>;
}

const TOOL_PROGRESS: Record<string, string> = {
  update_brief: "正在整理旅行条件",
  generate_plans: "正在寻找值得停留的地方",
  request_change: "正在计算调整后的路线与强度",
};

/** 空参数 schema（finalize_brief / generate_plans） */
const EmptyParams = Type.Object({});

// ---------- GLM Model（openai-completions 兼容端点） ----------
function buildGlmModel(): { model: Model<"openai-completions">; apiKey: string } | null {
  const apiKey = process.env.GLM_API_KEY ?? "";
  if (!apiKey || process.env.VITEST) return null;
  const baseUrl = process.env.GLM_BASE_URL ?? "https://open.bigmodel.cn/api/coding/paas/v4";
  const modelId = process.env.GLM_MODEL ?? "glm-5.2";
  return {
    apiKey,
    // 注意：id 会原样作为请求的 model 字段，必须是端点的裸模型名，不能加前缀
    model: {
      id: modelId, name: modelId, api: "openai-completions", provider: "zhipu-glm", baseUrl,
      reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000, maxTokens: 8192,
    },
  };
}

// ---------- 工具参数 schema（typebox） ----------
const BriefPatchSchema = Type.Object({
  destination: Type.Optional(Type.String({ description: "目的地：城市、省份或连续区域，如「川西」「新疆伊犁」" })),
  days: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, description: "完整游玩天数" })),
  adults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "成人数量" })),
  children: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, description: "儿童数量" })),
  childAges: Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: 17 }), { description: "每个孩子的年龄" })),
  seniors: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, description: "老人数量" })),
  pace: Type.Optional(Type.Union([Type.Literal("relaxed"), Type.Literal("balanced"), Type.Literal("compact")], { description: "节奏偏好" })),
  interests: Type.Optional(Type.Array(Type.String(), { description: "兴趣标签，如 自然风光、人文历史、美食" })),
  mustGo: Type.Optional(Type.Array(Type.String(), { description: "必去景点或区域" })),
  avoid: Type.Optional(Type.Array(Type.String(), { description: "不想去的地方或要素" })),
  startPoint: Type.Optional(Type.String({ description: "出发地" })),
  endPoint: Type.Optional(Type.String({ description: "结束返回地" })),
  earliestDeparture: Type.Optional(Type.String({ description: "每天最早出发时间 HH:mm" })),
  latestArrival: Type.Optional(Type.String({ description: "每天最晚到达时间 HH:mm" })),
  maxDriveHours: Type.Optional(Type.Number({ minimum: 1, maximum: 12, description: "单日驾驶时长上限（小时）" })),
  month: Type.Optional(Type.String({ description: "出行月份，如「10月」" })),
  notes: Type.Optional(Type.String({ description: "其他备注" })),
});
type BriefPatch = Static<typeof BriefPatchSchema>;

const AskQuestionSchema = Type.Object({
  question: Type.String({ description: "要问用户的问题，一次只问一个主题" }),
  quickReplies: Type.Optional(Type.Array(Type.String(), { description: "可选快捷回复，2-4 个" })),
});
type AskQuestion = Static<typeof AskQuestionSchema>;

const ChangeOperationSchema = Type.Union([
  Type.Object({ type: Type.Literal("add_place"), day: Type.Integer({ minimum: 1 }), placeName: Type.String() }),
  Type.Object({ type: Type.Literal("remove_place"), day: Type.Integer({ minimum: 1 }), placeName: Type.String() }),
  Type.Object({ type: Type.Literal("replace_place"), day: Type.Integer({ minimum: 1 }), placeName: Type.String(), replacement: Type.String() }),
  Type.Object({ type: Type.Literal("move_place"), day: Type.Integer({ minimum: 1 }), placeName: Type.String(), direction: Type.Union([Type.Literal("earlier"), Type.Literal("later")]) }),
  Type.Object({ type: Type.Literal("update_stay"), day: Type.Integer({ minimum: 1 }), stay: Type.String() }),
  Type.Object({ type: Type.Literal("lighten_day"), day: Type.Integer({ minimum: 1 }) }),
]);

const RequestChangeSchema = Type.Object({
  operations: Type.Array(ChangeOperationSchema, { minItems: 1, maxItems: 6, description: "结构化修改操作，day 从 1 开始计数" }),
});
type RequestChange = Static<typeof RequestChangeSchema>;

/** 工具副作用（属性收窄会被函数调用打断，避免 TS 把闭包赋值收窄成 never） */
interface TurnEffects {
  brief: TripBriefDraft;
  question: AskQuestion | null;
  finalized: boolean;
  trip: TripBundle | null;
  pendingChange: PlanChangeSet | null;
}

// ---------- 展示辅助 ----------
function planDigest(plan: Plan): string {
  return plan.days
    .map((day) => {
      const places = day.activities.filter((activity) => activity.type === "place").map((activity) => activity.place.name);
      return `第${day.day}天「${day.title}」：${places.join(" → ") || "（无景点）"}；住宿：${day.stay}；驾车 ${(day.totalDriveS / 3600).toFixed(1)} 小时；强度 ${day.intensity}`;
    })
    .join("\n");
}

function transcript(messages: AgentMessage[], userText: string, limit = 12): string {
  // 排除本轮刚追加的用户消息（它作为 prompt 单独传入）
  const history = messages.slice(-limit - 1);
  const trimmed = history.length && history.at(-1)?.role === "user" && history.at(-1)?.content === userText ? history.slice(0, -1) : history;
  if (!trimmed.length) return "";
  return `\n最近对话记录（供参考，最新一条是当前用户消息）:\n${trimmed.map((item) => `${item.role === "user" ? "用户" : "助手"}：${item.content}`).join("\n")}\n`;
}

function buildSystemPrompt(session: AgentSession, plan: Plan | null, userText: string): string {
  const lines = [
    "你是「去野」中文自驾旅行规划 Agent，与用户多轮对话，维护结构化的旅行需求（brief）并协助调整行程。",
    "",
    `当前需求档案：${JSON.stringify(session.brief)}`,
  ];
  if (plan) {
    lines.push("", `当前主方案「${plan.name}」：`, planDigest(plan));
  }
  if (session.pendingChange) {
    lines.push("", `当前有一个待确认的修改预览：${session.pendingChange.summary}（用户需用界面的「确认修改 / 取消」按钮处理，你只能解释它）。`);
  }
  lines.push(
    transcript(session.messages, userText),
    "工作规则：",
    "- 用户消息中出现新的或修正的旅行需求时，先调用 update_brief 写入（只传本次明确提到的字段，不要猜）。",
    plan
      ? "- 用户的修改意图（增删换移景点、改住宿、让某天轻松）必须转换为 operations 调用 request_change，不要用文字描述代替。"
      : "- 目的地、天数（以及带孩子时的儿童年龄）齐全后，如果还缺对规划影响大的关键偏好（必去、兴趣方向），最多再追问一轮。",
    plan
      ? "- 解释性提问（为什么这样安排、某景点情况、强度如何）直接用简洁中文回答，不要调用修改工具。"
      : "- 信息已足够时调用 finalize_brief 结束收集，并用一句话向用户确认需求总结。",
    plan ? "- 用户想确认或取消待定修改时，提示使用界面按钮，不要自行变更。" : "- 用户明确要求开始规划或生成方案时，调用 generate_plans。",
    "- 需要向用户提问时调用 ask_question，一次只问一个主题。",
    "- 不得编造距离、车程、票价或开放时间；涉及这些事实以工具结果为准。",
    "- 回复保持简洁中文。",
  );
  return lines.filter((line) => line !== undefined).join("\n");
}

function assistantTextFrom(messages: PiAgentMessage[]): string {
  let text = "";
  for (const item of messages) {
    if (item.role !== "assistant") continue;
    const joined = item.content
      .filter((part: unknown): part is { type: "text"; text: string } => typeof part === "object" && part !== null && "type" in part && part.type === "text")
      .map((part: { type: "text"; text: string }) => part.text.trim())
      .filter(Boolean)
      .join("\n");
    if (joined) text = joined;
  }
  return text;
}

// ---------- Runner ----------
export function createPiConversationRunner(): PiConversationRunner {
  return {
    async run(session, userText, bundle, deps) {
      const llm = buildGlmModel();
      if (!llm) return null;
      const plan = bundle ? (bundle.plans.find((item) => item.id === bundle.selectedPlanId) ?? bundle.plans[0]) : null;
      const effects: TurnEffects = { brief: session.brief, question: null, finalized: false, trip: null, pendingChange: null };

      const updateBriefTool: AgentTool<typeof BriefPatchSchema> = {
        name: "update_brief",
        label: "更新旅行需求",
        description: "把用户消息中「本次明确提到或修正」的旅行需求字段写入结构化档案。只传本次明确出现的字段，confirmedFields 由系统自动记录。",
        parameters: BriefPatchSchema,
        async execute(_toolCallId: string, params: BriefPatch) {
          const keys = Object.keys(params);
          effects.brief = mergeBrief(effects.brief, {
            ...(params as unknown as TripBriefDraft),
            confirmedFields: keys as TripBriefDraft["confirmedFields"],
          });
          const missing = missingFields(effects.brief);
          return {
            content: [{ type: "text", text: `已写入字段：${keys.join("、") || "（无）"}。当前档案：${JSON.stringify(effects.brief)}${missing.length ? `。仍缺失关键信息：${missing.join("、")}` : "。关键信息已齐。"}` }],
            details: { applied: keys, missing },
          };
        },
      };

      const askQuestionTool: AgentTool<typeof AskQuestionSchema> = {
        name: "ask_question",
        label: "向用户追问",
        description: "当需求档案缺少关键信息（目的地、天数、儿童年龄或影响规划的偏好）时，向用户提出一个具体问题。问完即停止本轮，等待用户回复。",
        parameters: AskQuestionSchema,
        async execute(_toolCallId: string, params: AskQuestion) {
          effects.question = params;
          return {
            content: [{ type: "text", text: `已向用户提问：${params.question}` }],
            details: params,
            terminate: true,
          };
        },
      };

      const finalizeBriefTool: AgentTool<typeof EmptyParams> = {
        name: "finalize_brief",
        label: "确认需求收齐",
        description: "需求档案信息已足够生成方案时调用，结束信息收集阶段。调用前先用一句话向用户确认需求总结。",
        parameters: EmptyParams,
        async execute() {
          const missing = missingFields(effects.brief);
          if (missing.length) throw new Error(`关键信息还缺失：${missing.join("、")}。请先追问，不要 finalize。`);
          effects.finalized = true;
          return {
            content: [{ type: "text", text: `需求已收齐。` }],
            details: { brief: effects.brief },
            terminate: true,
          };
        },
      };

      const generatePlansTool: AgentTool<typeof EmptyParams> = {
        name: "generate_plans",
        label: "生成两套方案",
        description: "用户明确要求开始规划、或确认需求总结后要求生成时调用。需要需求档案已含目的地和天数。",
        parameters: EmptyParams,
        async execute() {
          const missing = missingFields(effects.brief);
          if (missing.length) throw new Error(`关键信息还缺失：${missing.join("、")}。请先追问补齐。`);
          deps.onProgress("正在寻找值得停留的地方");
          effects.trip = await deps.generateTrip(toRequest(effects.brief));
          return {
            content: [{ type: "text", text: "两套方案已生成完毕。" }],
            details: { tripId: effects.trip.id, planNames: effects.trip.plans.map((item) => item.name) },
            terminate: true,
          };
        },
      };

      const requestChangeTool: AgentTool<typeof RequestChangeSchema> = {
        name: "request_change",
        label: "请求行程修改",
        description: "把用户的修改要求转换为最少量结构化操作并请求计算预览。day 从 1 开始；被操作的 placeName 必须是行程中已存在的景点名。",
        parameters: RequestChangeSchema,
        async execute(_toolCallId: string, params: RequestChange) {
          if (!bundle) throw new Error("当前没有行程，无法修改。");
          const operations = PlanChangeOperationSchema.array().parse(params.operations) as PlanChangeOperation[];
          deps.onProgress("正在计算调整后的路线与强度");
          const change = await deps.previewChange(bundle, operations);
          effects.pendingChange = change;
          return {
            content: [{ type: "text", text: `修改预览已生成：${change.summary}。受影响：第 ${change.affectedDays.join("、")} 天。` }],
            details: { summary: change.summary, affectedDays: change.affectedDays },
            terminate: true,
          };
        },
      };

      const tools: AgentTool[] = [updateBriefTool, askQuestionTool];
      if (plan) tools.push(requestChangeTool);
      else tools.push(finalizeBriefTool, generatePlansTool);

      let turns = 0;
      try {
        const finalMessages = await runAgentLoop(
          [{ role: "user", content: userText, timestamp: Date.now() }],
          { systemPrompt: buildSystemPrompt(session, plan, userText), messages: [], tools },
          {
            model: llm.model,
            apiKey: llm.apiKey,
            temperature: 0.3,
            maxTokens: 4096,
            convertToLlm: (messages: unknown) => messages as PiAgentMessage[],
            shouldStopAfterTurn: () => ++turns >= 8,
          },
          (event: { type: string; toolName?: string }) => {
            if (event.type === "tool_execution_start" && event.toolName) {
              const progress = TOOL_PROGRESS[event.toolName];
              if (progress) deps.onProgress(progress);
            }
          },
        );

        return composeOutcome(effects, finalMessages);
      } catch {
        // 循环失败（网络、鉴权、模型错误）：已产生的确定性效果仍然交付，否则整体回退规则路径
        return composeOutcome(effects, []);
      }
    },
  };
}

function composeOutcome(effects: TurnEffects, messages: PiAgentMessage[]): PiTurnOutcome | null {
  if (effects.trip) {
    return {
      brief: effects.brief,
      stage: "comparing",
      assistant: { content: "", kind: "comparison", quickReplies: [] },
      trip: effects.trip,
    };
  }
  if (effects.pendingChange) {
    return {
      brief: effects.brief,
      assistant: { content: "", kind: "change_preview", quickReplies: ["确认修改", "取消"] },
      pendingChange: effects.pendingChange,
    };
  }
  const assistantText = assistantTextFrom(messages);
  if (effects.question) {
    return {
      brief: effects.brief,
      assistant: {
        content: [assistantText, effects.question.question].filter(Boolean).join("\n\n"),
        kind: "question",
        quickReplies: effects.question.quickReplies ?? [],
      },
    };
  }
  if (effects.finalized) {
    return {
      brief: effects.brief,
      stage: "ready",
      assistant: { content: assistantText, kind: "brief", quickReplies: ["开始规划"] },
    };
  }
  if (assistantText) {
    return { brief: effects.brief, assistant: { content: assistantText, kind: "text", quickReplies: [] } };
  }
  return null;
}
