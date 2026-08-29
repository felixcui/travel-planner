/**
 * Phase 2 端到端冒烟：真实 GLM + 真实 pi 编排层（TravelAgentService + runPiTurn）。
 * 只验证对话编排链路（brief 收集 / 追问 / finalize），生成方案一步为可选（依赖外部地图/搜索服务）。
 *
 * 运行：set -a; source .env.local; set +a; npx vite-node -c vitest.config.ts scripts/pi-smoke.mts
 */
import { TravelAgentService } from "../src/server/services/agent";
import type { AgentEvent, AgentSession, TripBundle } from "../src/lib/domain";

delete process.env.VITEST; // vite-node 可能注入，确保 pi runner 正常启用

class MemorySessions {
  values = new Map<string, AgentSession>();
  async get(id: string) { return this.values.get(id) ?? null; }
  async save(session: AgentSession) { this.values.set(session.id, session); return session; }
}
class MemoryTrips {
  values = new Map<string, TripBundle>();
  async get(id: string) { return this.values.get(id) ?? null; }
  async save(bundle: TripBundle) { this.values.set(bundle.id, bundle); return bundle; }
}

function dump(session: AgentSession, label: string) {
  const last = session.messages.at(-1);
  console.log(`\n[${label}] stage=${session.stage} | brief=${JSON.stringify({ ...session.brief, confirmedFields: undefined })}`);
  console.log(`  消息(${session.messages.length}) 末条：${last ? `${last.role}/${last.kind}: ${last.content.slice(0, 120).replace(/\n/g, " ")}` : "（无）"}`);
}

async function main() {
  const sessions = new MemorySessions();
  const trips = new MemoryTrips();
  const service = new TravelAgentService(sessions, trips); // 默认 pi runner（真实 GLM）
  const events: AgentEvent[] = [];
  const emit = (event: AgentEvent) => { events.push(event); };

  let session = await service.createSession();
  console.log(`会话已建立：${session.id}，pi 路径=${process.env.GLM_API_KEY ? "已启用" : "未启用（回退规则）"}`);

  const turns: Array<[string, string]> = [
    ["T1 初始模糊需求", "带孩子去新疆伊犁自驾 7 天，4 个成人，节奏轻松"],
    ["T2 补儿童年龄+偏好", "孩子 7 岁，喜欢自然风光，必去赛里木湖和那拉提，别的都随意"],
    ["T3 要求开始规划", "可以了，开始规划吧"],
  ];
  for (const [label, text] of turns) {
    const start = Date.now();
    const result = await service.handleTurn(session.id, { type: "message", message: text }, emit);
    session = result.session;
    dump(session, `${label} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
    if (session.stage === "comparing" && session.tripId) {
      console.log(`  行程已生成：${session.tripId}，方案数 ${trips.values.get(session.tripId)?.plans.length ?? "?"}`);
      break;
    }
  }

  console.log(`\n事件统计：progress=${events.filter((e) => e.type === "progress").length}，trip=${events.filter((e) => e.type === "trip").length}，session=${events.filter((e) => e.type === "session").length}`);
  const ok = session.stage === "ready" || session.stage === "comparing" || session.messages.some((m) => m.role === "assistant" && m.kind === "question" && session.stage === "collecting");
  console.log(ok ? "\n冒烟结论：pi 编排链路工作正常" : "\n冒烟结论：状态异常，请检查日志");
}

main().catch((error) => { console.error("冒烟失败：", error); process.exit(1); });
