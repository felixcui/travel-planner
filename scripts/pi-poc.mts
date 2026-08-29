/**
 * Phase 1 PoC：验证 GLM（智谱 OpenAI 兼容端点）在 pi-ai / pi-agent-core 下的
 * tool calling 稳定性与 agent loop 多轮行为。
 *
 * 运行：node --experimental-strip-types --env-file=.env.local scripts/pi-poc.mts
 *
 * 验证点：
 *  1. 自定义 Model 指向 open.bigmodel.cn，openai-completions API 连通
 *  2. GLM 能稳定返回合法 tool call 参数（typebox schema 校验）
 *  3. agent loop 多轮循环：update_brief 结构化写入 + ask_question 追问后终止
 *  4. usage / cost 统计可用
 *  5. 多轮对话（同一 context 二次输入）brief 增量更新
 */
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentTool } from "@mariozechner/pi-agent-core";
import { runAgentLoop } from "@mariozechner/pi-agent-core";
import type { Model, Message } from "@mariozechner/pi-ai";
import { Type } from "@mariozechner/pi-ai";

// ---------- 配置：GLM 自定义 Model ----------
const baseUrl = process.env.GLM_BASE_URL ?? "https://open.bigmodel.cn/api/coding/paas/v4";
const apiKey = process.env.GLM_API_KEY ?? "";
const modelId = process.env.GLM_MODEL ?? "glm-5.2";

const glmModel: Model<"openai-completions"> = {
  id: modelId, // 注意：id 会原样作为 API 的 model 字段发送，必须是智谱的裸模型名，不能带前缀
  name: modelId,
  api: "openai-completions",
  provider: "zhipu-glm",
  baseUrl,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8192,
};

// ---------- 共享 brief 状态（工具代码维护，LLM 只能通过参数写入） ----------
type Brief = {
  destination?: string;
  days?: number;
  adults?: number;
  children?: number;
  childAges?: number[];
  seniors?: number;
  pace?: "relaxed" | "balanced" | "compact";
  interests?: string[];
  mustGo?: string[];
  avoid?: string[];
  maxDriveHours?: number;
  notes?: string;
  confirmedFields: string[];
};

const brief: Brief = { confirmedFields: [] };
const toolCallLog: Array<{ name: string; args: unknown; ok: boolean }> = [];

// ---------- 工具 1：update_brief（判断在 LLM，写入在代码） ----------
const BriefPatch = Type.Object({
  destination: Type.Optional(Type.String({ description: "目的地：城市、省份或连续区域，如「川西」「新疆伊犁」" })),
  days: Type.Optional(Type.Integer({ minimum: 1, maximum: 60, description: "完整游玩天数" })),
  adults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "成人数量" })),
  children: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, description: "儿童数量" })),
  childAges: Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: 17 }), { description: "每个孩子的年龄" })),
  seniors: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, description: "老人数量" })),
  pace: Type.Optional(Type.Union([Type.Literal("relaxed"), Type.Literal("balanced"), Type.Literal("compact")], { description: "节奏偏好" })),
  interests: Type.Optional(Type.Array(Type.String(), { description: "兴趣标签，如 自然风光、人文历史、美食" })),
  mustGo: Type.Optional(Type.Array(Type.String(), { description: "必去景点或区域" })),
  avoid: Type.Optional(Type.Array(Type.String(), { description: "不想去的地方" })),
  maxDriveHours: Type.Optional(Type.Number({ minimum: 1, maximum: 12, description: "单日驾驶时长上限（小时）" })),
  notes: Type.Optional(Type.String({ description: "其他备注" })),
});

const updateBriefTool: AgentTool<typeof BriefPatch> = {
  name: "update_brief",
  label: "更新旅行需求",
  description:
    "把用户消息中「本次明确提到或修正」的旅行需求字段写入结构化档案。只传本次消息里明确出现的字段，不要猜测或补全用户没有说的内容。confirmedFields 由系统自动记录，不需要你提供。",
  parameters: BriefPatch,
  async execute(_toolCallId, params) {
    const applied: string[] = [];
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      (brief as Record<string, unknown>)[key] = value;
      applied.push(key);
    }
    brief.confirmedFields = [...new Set([...brief.confirmedFields, ...applied])];
    toolCallLog.push({ name: "update_brief", args: params, ok: true });
    const missing: string[] = [];
    if (!brief.destination) missing.push("destination");
    if (!brief.days) missing.push("days");
    return {
      content: [{
        type: "text",
        text: `已写入字段：${applied.join("、") || "（无）"}。当前需求档案：${JSON.stringify(brief)}${missing.length ? `。仍缺失：${missing.join("、")}` : ""}。需求已完整。`,
      }],
      details: { applied, missing },
    };
  },
};

// ---------- 工具 2：ask_question（追问并终止本轮循环） ----------
const AskQuestion = Type.Object({
  question: Type.String({ description: "要问用户的问题，一次只问一个主题" }),
  quickReplies: Type.Optional(Type.Array(Type.String(), { description: "可选快捷回复" })),
});

const askQuestionTool: AgentTool<typeof AskQuestion> = {
  name: "ask_question",
  label: "向用户追问",
  description: "当需求档案缺少关键信息（目的地、天数、或影响规划的偏好）时，向用户提出一个具体问题。问完即停止本轮，等待用户回复。",
  parameters: AskQuestion,
  async execute(_toolCallId, params) {
    toolCallLog.push({ name: "ask_question", args: params, ok: true });
    return {
      content: [{ type: "text", text: `已向用户提问：${params.question}` }],
      details: params,
      terminate: true, // 关键：问完停止循环，控制权交还用户
    };
  },
};

// ---------- agent 配置 ----------
const SYSTEM_PROMPT = `你是中文自驾旅行规划助手，任务是收集并维护结构化的旅行需求（brief）。
工作方式：
- 用户消息里出现需求信息时，先调用 update_brief 写入（只传本次明确提到的字段），再决定下一步。
- 目的地和天数齐全后：若还缺对规划影响大的关键偏好（如必去、兴趣方向、不想去的地方），可以问一轮；若信息已足够，直接向用户确认一份简短的需求总结，然后停止。
- 需要提问时调用 ask_question，一次只问一个主题。
- 不要编造用户没有说过的信息。回复保持简洁中文。`;

const config: AgentLoopConfig = {
  model: glmModel,
  apiKey,
  temperature: 0.3,
  maxTokens: 4096,
  reasoning: "off",
  convertToLlm: (messages) => messages as Message[],
  shouldStopAfterTurn: () => false,
};

// ---------- 运行与报告 ----------
interface RunStats {
  turns: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  errors: string[];
}

async function runTurn(context: AgentContext, userText: string, label: string): Promise<RunStats> {
  console.log(`\n\x1b[36m${"=".repeat(64)}\n${label}\n用户：${userText}\n${"=".repeat(64)}\x1b[0m`);
  const stats: RunStats = { turns: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, errors: [] };
  const start = Date.now();
  const emit = (event: AgentEvent) => {
    if (event.type === "turn_start") { stats.turns++; stats.llmCalls++; }
    if (event.type === "turn_end") {
      const usage = event.message.role === "assistant" ? event.message.usage : null;
      if (usage) { stats.inputTokens += usage.input; stats.outputTokens += usage.output; }
      const parts = event.message.role === "assistant"
        ? event.message.content.map((c) => {
            if (c.type === "toolCall") return `\x1b[33m  [toolCall] ${c.name} ${JSON.stringify(c.arguments)}\x1b[0m`;
            if (c.type === "text" && c.text.trim()) return `\x1b[32m  [assistant] ${c.text.trim().replace(/\n/g, "\n  ")}\x1b[0m`;
            return null;
          }).filter(Boolean)
        : [];
      if (parts.length) console.log(parts.join("\n"));
      const stop = event.message.role === "assistant" ? event.message.stopReason : "";
      const err = event.message.role === "assistant" ? event.message.errorMessage : undefined;
      if (err) { stats.errors.push(err); console.log(`  \x1b[31m[stop=${stop}] error: ${err}\x1b[0m`); }
    }
  };
  try {
    await runAgentLoop(
      [{ role: "user", content: userText, timestamp: Date.now() }],
      context,
      { ...config, shouldStopAfterTurn: () => stats.llmCalls >= 8 },
      emit,
    );
  } catch (error) {
    stats.errors.push(String(error));
    console.log(`\x1b[31m循环异常：${String(error)}\x1b[0m`);
  }
  stats.durationMs = Date.now() - start;
  return stats;
}

function report(stats: RunStats) {
  console.log(`\n  耗时 ${(stats.durationMs / 1000).toFixed(1)}s | LLM 调用 ${stats.llmCalls} 次 | tokens in=${stats.inputTokens} out=${stats.outputTokens} | 错误 ${stats.errors.length}`);
}

async function main() {
  if (!apiKey) { console.error("缺少 GLM_API_KEY"); process.exit(1); }
  console.log(`模型：${modelId} @ ${baseUrl}`);

  // 场景 1：模糊需求 → 期望 update_brief + ask_question
  const ctx1: AgentContext = { systemPrompt: SYSTEM_PROMPT, messages: [], tools: [updateBriefTool, askQuestionTool] };
  const s1 = await runTurn(ctx1, "想去川西玩 5 天，2 大 1 小，孩子 7 岁，第一次去", "场景 1：模糊需求（缺兴趣/必去）");
  report(s1);

  // 场景 2：完整需求 → 期望一次 update_brief 后直接总结停止，不滥用提问
  const ctx2: AgentContext = { systemPrompt: SYSTEM_PROMPT, messages: [], tools: [updateBriefTool, askQuestionTool] };
  const s2 = await runTurn(ctx2, "去新疆伊犁自驾 7 天，4 个成人，节奏轻松，喜欢自然风光，必去赛里木湖和那拉提，每天开车别超过 5 小时，避开人太多太商业化的地方", "场景 2：完整需求（信息基本齐全）");
  report(s2);

  // 场景 3：多轮增量 —— 基于场景 1 的 context 继续对话
  console.log(`\n\x1b[36m场景 3：多轮增量更新（延续场景 1 的对话上下文）\x1b[0m`);
  const s3 = await runTurn(ctx1, "没有特别必去的，主要想看自然风光和藏区人文，别安排徒步", "场景 3：补充偏好（应增量合并，不覆盖天数/人数）");
  report(s3);

  console.log("\n\x1b[36m===== 最终 brief =====\x1b[0m");
  console.log(JSON.stringify(brief, null, 2));
  console.log("\n\x1b[36m===== 工具调用序列 =====\x1b[0m");
  for (const [i, call] of toolCallLog.entries()) {
    console.log(`${i + 1}. ${call.name} ${JSON.stringify(call.args)}`);
  }
  const totalErrors = s1.errors.length + s2.errors.length + s3.errors.length;
  const totalCalls = s1.llmCalls + s2.llmCalls + s3.llmCalls;
  const totalIn = s1.inputTokens + s2.inputTokens + s3.inputTokens;
  const totalOut = s1.outputTokens + s2.outputTokens + s3.outputTokens;
  console.log(`\n汇总：LLM 调用 ${totalCalls} 次，tokens in=${totalIn} out=${totalOut}，错误 ${totalErrors}`);
  console.log(totalErrors === 0 ? "\x1b[32mPoC 结论：GLM tool calling 与 agent loop 工作正常\x1b[0m" : "\x1b[31mPoC 结论：存在错误，见上方日志\x1b[0m");
}

main();
