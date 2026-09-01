import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentSession, TripBundle } from "@/lib/domain";
import type { PiConversationRunner, PiTurnOutcome } from "./pi-conversation";
import { extractTripBriefFallback, interpretPlanChangeFallback, TravelAgentService } from "./agent";

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

function fakeRunner(outcome: PiTurnOutcome | null): PiConversationRunner {
  return {
    async run() {
      return outcome;
    },
  };
}

function outcomeBase(patch: Partial<PiTurnOutcome>): PiTurnOutcome {
  return { brief: { destination: "川西", days: 5, confirmedFields: ["destination", "days"] }, assistant: { content: "", kind: "text", quickReplies: [] }, ...patch };
}

describe("TravelAgentService", () => {
  it("从一句自然语言中提取自驾需求", () => {
    const brief = extractTripBriefFallback("想去川西玩5天，2大1小，孩子8岁，节奏轻松，喜欢自然风光，驾驶不超过4小时");
    expect(brief).toMatchObject({ destination: "川西", days: 5, adults: 2, children: 1, childAges: [8], pace: "relaxed", maxDriveHours: 4 });
    expect(brief.interests).toContain("自然风光");
    expect(brief.mustGo).toBeUndefined();
  });

  it("从成都出发回成都时正确区分出发地与目的地", () => {
    const brief = extractTripBriefFallback("我想从成都出发，最后回到成都，去川西玩5天");
    expect(brief).toMatchObject({ startPoint: "成都", endPoint: "成都", destination: "川西", days: 5 });
    expect(brief.confirmedFields).toEqual(expect.arrayContaining(["startPoint", "endPoint", "destination", "days"]));
  });

  it("只说出发地时兜底为目的地，不卡收集阶段", async () => {
    const sessions = new MemorySessions();
    const service = new TravelAgentService(sessions, new MemoryTrips());
    let session = await service.createSession();
    ({ session } = await service.handleTurn(session.id, { type: "message", message: "从成都出发自驾5天" }));
    expect(session.brief).toMatchObject({ startPoint: "成都", destination: "成都", days: 5 });
    expect(session.stage).toBe("collecting");
  });

  it("修改轮补充出发地时不覆盖已有目的地", async () => {
    const sessions = new MemorySessions();
    const service = new TravelAgentService(sessions, new MemoryTrips());
    let session = await service.createSession();
    ({ session } = await service.handleTurn(session.id, { type: "message", message: "去川西玩5天" }));
    ({ session } = await service.handleTurn(session.id, { type: "message", message: "改成 7 天，然后从成都出发，最后回到成都" }));
    expect(session.brief).toMatchObject({ destination: "川西", days: 7, startPoint: "成都", endPoint: "成都" });
  });

  it("儿童年龄缺失时继续追问；补充需求后进入多轮访谈，访谈完才 ready", async () => {
    const sessions = new MemorySessions();
    const service = new TravelAgentService(sessions, new MemoryTrips());
    let session = await service.createSession();
    ({ session } = await service.handleTurn(session.id, { type: "message", message: "去川西玩5天，2大1小，节奏轻松" }));
    expect(session.stage).toBe("collecting");
    expect(session.messages.at(-1)?.content).toContain("孩子");
    ({ session } = await service.handleTurn(session.id, { type: "message", message: "孩子8岁，必去四姑娘山，喜欢自然风光" }));
    expect(session.stage).toBe("collecting");
    expect(session.messages.at(-1)?.content).toContain("不想去");
    expect(session.brief.childAges).toEqual([8]);
    expect(session.brief.mustGo).toContain("四姑娘山");
    ({ session } = await service.handleTurn(session.id, { type: "message", message: "没有" }));
    expect(session.stage).toBe("ready");
  });

  it("开始规划前会先追问必去景点，而不是直接 ready", async () => {
    const sessions = new MemorySessions();
    const service = new TravelAgentService(sessions, new MemoryTrips());
    let session = await service.createSession();
    ({ session } = await service.handleTurn(session.id, { type: "message", message: "去新疆玩10天，北疆大环线，2位成人" }));
    expect(session.stage).toBe("collecting");
    expect(session.messages.at(-1)?.content).toContain("必去");
  });

  it("把常见修改要求限制为结构化操作", () => {
    const plan = {
      id: "plan_1", name: "经典", tagline: "少折返", accent: "vermillion" as const, version: 1, createdAt: "2026-08-07T00:00:00.000Z",
      days: [{ id: "day_1", day: 2, title: "雪山", activities: [], segments: [], stay: "康定", stayReason: "衔接", totalDistanceM: 0, totalDriveS: 0, intensity: "balanced" as const, issues: [] }],
    };
    expect(interpretPlanChangeFallback("第二天轻松一点", plan)).toEqual([{ type: "lighten_day", day: 2 }]);
    expect(interpretPlanChangeFallback("第二天把甲居藏寨换成墨石公园", plan)).toEqual([{ type: "replace_place", day: 2, placeName: "甲居藏寨", replacement: "墨石公园" }]);
  });

  it("确认修改时拒绝覆盖已经变化的方案版本", async () => {
    const sessions = new MemorySessions();
    const trips = new MemoryTrips();
    const plan = { id: "plan_1", name: "经典", tagline: "少折返", accent: "vermillion" as const, version: 2, createdAt: "2026-08-07T00:00:00.000Z", days: [] };
    const trip: TripBundle = {
      schemaVersion: 2, id: "trip_1", request: { destination: "川西", days: 1, adults: 2, children: 0, childAges: [], seniors: 0, pace: "balanced", interests: [], mustGo: [], avoid: [], earliestDeparture: "09:00", latestArrival: "19:30", maxDriveHours: 5, notes: "" },
      plans: [plan], selectedPlanId: plan.id, sourceMode: "demo", revisions: [], createdAt: plan.createdAt, updatedAt: plan.createdAt,
    };
    const session: AgentSession = {
      schemaVersion: 1, id: "session_1", stage: "editing", brief: { destination: "川西", days: 1, confirmedFields: ["destination", "days"] }, interviewQueue: [], messages: [], tripId: trip.id,
      pendingChange: { id: "change_1", planId: plan.id, baseVersion: 1, summary: "精简", affectedDays: [1], operations: [{ type: "lighten_day", day: 1 }], before: { distanceM: 0, driveS: 0, tiringDays: 0, placeCount: 0 }, after: { distanceM: 0, driveS: 0, tiringDays: 0, placeCount: 0 }, proposedPlan: { ...plan, version: 2 }, createdAt: plan.createdAt },
      createdAt: plan.createdAt, updatedAt: plan.createdAt,
    };
    await sessions.save(session); await trips.save(trip);
    await expect(new TravelAgentService(sessions, trips).handleTurn(session.id, { type: "confirm_change" })).rejects.toThrow("已经发生变化");
  });

  it("pi runner 返回追问时：写入 brief 并以 question 消息收尾，stage 不变", async () => {
    const sessions = new MemorySessions();
    const trips = new MemoryTrips();
    const runner = fakeRunner(outcomeBase({
      brief: { destination: "川西", days: 5, children: 1, confirmedFields: ["destination", "days", "children"] },
      assistant: { content: "孩子大约几岁？", kind: "question", quickReplies: ["8岁", "10岁"] },
    }));
    const service = new TravelAgentService(sessions, trips, runner);
    let session = await service.createSession();
    ({ session } = await service.handleTurn(session.id, { type: "message", message: "带孩子去川西玩5天" }));
    expect(session.brief.children).toBe(1);
    expect(session.stage).toBe("collecting");
    const last = session.messages.at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.kind).toBe("question");
    expect(last.quickReplies).toEqual(["8岁", "10岁"]);
  });

  it("pi runner 返回 finalize 时：stage 变 ready，附开始规划快捷回复", async () => {
    const sessions = new MemorySessions();
    const trips = new MemoryTrips();
    const runner = fakeRunner(outcomeBase({
      stage: "ready",
      assistant: { content: "我整理好了：川西 · 5 天 · 2 位成人。", kind: "brief", quickReplies: ["开始规划"] },
    }));
    const service = new TravelAgentService(sessions, trips, runner);
    let session = await service.createSession();
    ({ session } = await service.handleTurn(session.id, { type: "message", message: "川西5天2人，开始吧" }));
    expect(session.stage).toBe("ready");
    expect(session.messages.at(-1)?.kind).toBe("brief");
    expect(session.messages.at(-1)?.quickReplies).toEqual(["开始规划"]);
  });

  it("pi runner 生成方案时：行程落库、stage 变 editing、emit trip 事件", async () => {
    const sessions = new MemorySessions();
    const trips = new MemoryTrips();
    const plan = { id: "plan_1", name: "经典", tagline: "少折返", accent: "vermillion" as const, version: 1, createdAt: "2026-08-07T00:00:00.000Z", days: [] };
    const generated: TripBundle = {
      schemaVersion: 2, id: "trip_gen", request: { destination: "川西", days: 5, adults: 2, children: 0, childAges: [], seniors: 0, pace: "balanced", interests: [], mustGo: [], avoid: [], earliestDeparture: "09:00", latestArrival: "19:30", maxDriveHours: 5, notes: "" },
      plans: [plan], selectedPlanId: plan.id, sourceMode: "demo", revisions: [], createdAt: plan.createdAt, updatedAt: plan.createdAt,
    };
    const runner = fakeRunner(outcomeBase({ stage: "editing", assistant: { content: "", kind: "status", quickReplies: [] }, trip: generated }));
    const service = new TravelAgentService(sessions, trips, runner);
    let session = await service.createSession();
    const events: AgentEvent[] = [];
    ({ session } = await service.handleTurn(session.id, { type: "message", message: "确认，开始详细规划" }, (event) => events.push(event)));
    expect(session.stage).toBe("editing");
    expect(session.tripId).toBe("trip_gen");
    expect(trips.values.get("trip_gen")?.agentSessionId).toBe(session.id);
    expect(events.some((event) => event.type === "trip")).toBe(true);
  });

  it("pi runner 返回草案时：stage 变 drafting、outline 存入 session、消息 kind 为 outline", async () => {
    const sessions = new MemorySessions();
    const trips = new MemoryTrips();
    const outline = { version: 1, summary: "川西 5 天草案", days: [{ day: 1, title: "抵达川西", places: ["折多山"], stay: "康定" }], highlights: ["从成都出发"], notes: "" };
    const runner = fakeRunner(outcomeBase({
      stage: "drafting",
      outline,
      assistant: { content: "草案 v1 已生成。", kind: "outline", quickReplies: ["确认并详细规划", "再调整调整"] },
    }));
    const service = new TravelAgentService(sessions, trips, runner);
    let session = await service.createSession();
    ({ session } = await service.handleTurn(session.id, { type: "message", message: "出个初步方案" }));
    expect(session.stage).toBe("drafting");
    expect(session.outline).toMatchObject({ version: 1, summary: "川西 5 天草案" });
    expect(session.messages.at(-1)?.kind).toBe("outline");
    expect(session.messages.at(-1)?.quickReplies).toContain("确认并详细规划");
  });

  it("规则路径：ready 后 create_outline 生成草案进入 drafting；drafting 反馈迭代草案版本号递增", async () => {
    const sessions = new MemorySessions();
    const trips = new MemoryTrips();
    const service = new TravelAgentService(sessions, trips, null as unknown as PiConversationRunner);
    let session = await service.createSession();
    // 快速到 ready
    ({ session } = await service.handleTurn(session.id, { type: "message", message: "去川西玩5天，必去折多山，喜欢摄影，避开人造景区" }));
    expect(session.stage).toBe("ready");
    // create_outline → drafting（LLM 不可用走确定性回退草案）
    ({ session } = await service.handleTurn(session.id, { type: "create_outline" }));
    expect(session.stage).toBe("drafting");
    expect(session.outline).toBeDefined();
    expect(session.outline!.version).toBe(1);
    expect(session.outline!.days.length).toBe(5);
    expect(session.outline!.days[0].places).toContain("折多山");
    expect(session.messages.at(-1)?.kind).toBe("outline");
    expect(session.messages.at(-1)?.quickReplies).toContain("确认并详细规划");
    // drafting 反馈迭代（确定性回退，version+1）
    ({ session } = await service.handleTurn(session.id, { type: "message", message: "第二天改成 8 点前出发" }));
    expect(session.stage).toBe("drafting");
    expect(session.outline!.version).toBe(2);
    expect(session.messages.at(-1)?.kind).toBe("outline");
  });

  it("规则路径：ready 阶段 generate 被拒，需先出草案", async () => {
    const sessions = new MemorySessions();
    const service = new TravelAgentService(sessions, new MemoryTrips(), fakeRunner(null));
    let session = await service.createSession();
    ({ session } = await service.handleTurn(session.id, { type: "message", message: "去川西玩5天，必去折多山，喜欢摄影，避开人造景区" }));
    expect(session.stage).toBe("ready");
    // ready 阶段 generate 被拒（需先出草案）；进入 drafting 后校验通过（真实详细规划依赖地图网络，不在单测中执行）
    await expect(service.handleTurn(session.id, { type: "generate" })).rejects.toThrow("请先出初步方案");
    ({ session } = await service.handleTurn(session.id, { type: "create_outline" }));
    expect(session.stage).toBe("drafting");
    expect(session.outline).toBeDefined();
  });

  it("旧版 comparing 会话收到消息时自动迁移为 editing", async () => {
    const sessions = new MemorySessions();
    const trips = new MemoryTrips();
    const plan = { id: "plan_1", name: "经典", tagline: "", accent: "vermillion" as const, version: 1, createdAt: "2026-08-07T00:00:00.000Z", days: [] };
    const trip: TripBundle = {
      schemaVersion: 2, id: "trip_old", request: { destination: "川西", days: 1, adults: 2, children: 0, childAges: [], seniors: 0, pace: "balanced", interests: [], mustGo: [], avoid: [], earliestDeparture: "09:00", latestArrival: "19:30", maxDriveHours: 5, notes: "" },
      plans: [plan], selectedPlanId: plan.id, sourceMode: "demo", revisions: [], createdAt: plan.createdAt, updatedAt: plan.createdAt,
    };
    await trips.save(trip);
    const session: AgentSession = {
      schemaVersion: 1, id: "session_old", stage: "comparing", brief: { destination: "川西", days: 1, confirmedFields: ["destination", "days"] }, interviewQueue: [], messages: [], tripId: trip.id,
      createdAt: plan.createdAt, updatedAt: plan.createdAt,
    };
    await sessions.save(session);
    const service = new TravelAgentService(sessions, trips, fakeRunner(null));
    // 解释性消息（不触发修改正则）也应完成 comparing → editing 迁移
    const { session: updated } = await service.handleTurn(session.id, { type: "message", message: "这套方案整体怎么样" });
    expect(updated.stage).toBe("editing");
  });

  it("pi runner 返回 null 时：回退规则路径", async () => {
    const sessions = new MemorySessions();
    const trips = new MemoryTrips();
    const service = new TravelAgentService(sessions, trips, fakeRunner(null));
    let session = await service.createSession();
    ({ session } = await service.handleTurn(session.id, { type: "message", message: "去新疆玩10天，北疆大环线，2位成人" }));
    expect(session.stage).toBe("collecting");
    expect(session.messages.at(-1)?.content).toContain("必去");
  });
});
