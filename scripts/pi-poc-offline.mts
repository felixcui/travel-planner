/**
 * Phase 1 PoC 离线部分：不依赖真实 GLM key，用 pi-ai 的 faux provider 模拟
 * GLM 的多轮 tool calling 行为，验证 agent loop 集成路径的正确性。
 *
 * 运行：node --experimental-strip-types --no-warnings scripts/pi-poc-offline.mts
 *
 * 模拟剧本（模拟 GLM 真实可能的响应序列）：
 *  turn 1: toolCall(update_brief, {destination, days, adults, children, childAges})
 *  turn 2: toolCall(ask_question, {question: "..."})  → terminate=true 应终止循环
 *  turn 3: （不应被执行；若被执行则 terminate 失效）
 */
import type { AgentContext, AgentLoopConfig, AgentTool, AgentEvent } from "@mariozechner/pi-agent-core";
import { runAgentLoop } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { registerFauxProvider, fauxToolCall, fauxAssistantMessage } from "@mariozechner/pi-ai";

const registration = registerFauxProvider({ api: "openai-completions", provider: "faux-glm" });
const model = registration.getModel();

// ---------- 与 pi-poc.mts 相同的工具定义 ----------
type Brief = {
  destination?: string;
  days?: number;
  adults?: number;
  children?: number;
  childAges?: number[];
  confirmedFields: string[];
};
const brief: Brief = { confirmedFields: [] };
const toolCallLog: Array<{ name: string; args: unknown }> = [];

const updateBriefTool: AgentTool<any> = {
  name: "update_brief",
  label: "更新旅行需求",
  description: "写入用户明确提到的旅行需求字段",
  parameters: {
    type: "object",
    properties: {
      destination: { type: "string", description: "目的地" },
      days: { type: "integer", minimum: 1, maximum: 60 },
      adults: { type: "integer", minimum: 1 },
      children: { type: "integer", minimum: 0 },
      childAges: { type: "array", items: { type: "integer", minimum: 0, maximum: 17 } },
    },
  },
  async execute(_id, params: Record<string, unknown>) {
    const applied: string[] = [];
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      (brief as Record<string, unknown>)[key] = value;
      applied.push(key);
    }
    brief.confirmedFields = [...new Set([...brief.confirmedFields, ...applied])];
    toolCallLog.push({ name: "update_brief", args: params });
    return {
      content: [{ type: "text", text: `已写入：${applied.join("、")}。档案：${JSON.stringify(brief)}` }],
      details: { applied },
    };
  },
};

const askQuestionTool: AgentTool<any> = {
  name: "ask_question",
  label: "向用户追问",
  description: "缺少关键信息时向用户提问",
  parameters: {
    type: "object",
    properties: { question: { type: "string" } },
    required: ["question"],
  },
  async execute(_id, params: { question: string }) {
    toolCallLog.push({ name: "ask_question", args: params });
    return { content: [{ type: "text", text: `已提问：${params.question}` }], details: params, terminate: true };
  },
};

// ---------- 模拟 GLM 的响应序列 ----------
registration.setResponses([
  fauxAssistantMessage([
    fauxToolCall("update_brief", { destination: "川西", days: 5, adults: 2, children: 1, childAges: [7] }),
  ]),
  fauxAssistantMessage([
    fauxToolCall("ask_question", { question: "更偏向哪种玩法？自然风光、人文历史，还是轻松亲子？" }),
  ]),
  // 如果 terminate 失效，这轮会被执行并导致断言失败之外的额外输出
  fauxAssistantMessage("这轮不应该出现（terminate 应已终止循环）"),
]);

// ---------- 断言 ----------
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "\x1b[32m✓" : "\x1b[31m✗"} ${name}\x1b[0m${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
}

async function main() {
  const context: AgentContext = {
    systemPrompt: "测试系统提示",
    messages: [],
    tools: [updateBriefTool, askQuestionTool],
  };
  const config: AgentLoopConfig = {
    model,
    convertToLlm: (messages) => messages as Message[],
  };

  const events: string[] = [];
  const messages = await runAgentLoop(
    [{ role: "user", content: "想去川西玩 5 天，2 大 1 小，孩子 7 岁", timestamp: Date.now() }],
    context,
    config,
    (event: AgentEvent) => { events.push(event.type); },
  );

  console.log("事件序列:", events.join(" → "));
  console.log("工具调用:", JSON.stringify(toolCallLog.map((c) => c.name)));
  console.log("最终 brief:", JSON.stringify(brief));

  check("agent loop 正常结束（agent_end）", events.includes("agent_end"));
  check("update_brief 被执行且参数正确写入",
    brief.destination === "川西" && brief.days === 5 && brief.adults === 2 && brief.childAges?.[0] === 7);
  check("confirmedFields 自动推导（代码守卫，非 LLM 职责）",
    brief.confirmedFields.includes("destination") && brief.confirmedFields.includes("childAges"));
  check("ask_question 执行且 terminate 终止循环", toolCallLog.some((c) => c.name === "ask_question"));
  check("terminate 生效：没有多余的第三轮 LLM 调用", registration.state.callCount === 2, `实际调用 ${registration.state.callCount} 次`);
  check("事件含 tool_execution_start/end", events.includes("tool_execution_start") && events.includes("tool_execution_end"));
  check("turn_end 消息带回上下文（供持久化）", messages.some((m) => m.role === "assistant"));

  console.log(failures === 0 ? "\n\x1b[32m离线验证全部通过：agent loop / 工具校验 / terminate / 事件流工作正常\x1b[0m" : `\n\x1b[31m${failures} 项断言失败\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
