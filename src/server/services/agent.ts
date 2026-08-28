import { z } from "zod";
import type { AgentEvent, AgentMessage, AgentSession, Plan, PlanChangeOperation, PlanChangeSet, TripBriefDraft, TripBundle, TripRequest } from "@/lib/domain";
import { AgentSessionSchema, PlanChangeOperationSchema, TripRequestSchema } from "@/lib/domain";
import { id, summarizePlan } from "@/lib/utils";
import { FileAgentSessionRepository, FileTripRepository } from "../repositories/files";
import { createLlmProvider } from "../providers/llm";
import { generateTrip, recalculatePlan, resolvePlace } from "./planning";

export const AgentTurnInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), message: z.string().trim().min(1).max(2000) }),
  z.object({ type: z.literal("generate") }),
  z.object({ type: z.literal("select_plan"), planId: z.string() }),
  z.object({ type: z.literal("confirm_change") }),
  z.object({ type: z.literal("cancel_change") }),
  z.object({ type: z.literal("restore_revision"), revisionId: z.string() }),
]);
export type AgentTurnInput = z.infer<typeof AgentTurnInputSchema>;

const defaults: TripBriefDraft = {
  adults: 2,
  children: 0,
  childAges: [],
  seniors: 0,
  pace: "balanced",
  interests: [],
  mustGo: [],
  avoid: [],
  earliestDeparture: "09:00",
  latestArrival: "19:30",
  maxDriveHours: 5,
  notes: "",
  confirmedFields: [],
};

// 生成方案前需要多轮补充的信息，每轮一问；命中或用户回答“没有”等即可进入下一题。
const INTERVIEW_STEPS = [
  { id: "mustGo", question: "这次有没有非去不可的景点或区域？比如某个湖、古城、景区。没有的话回复“没有必去”即可。", quickReplies: ["没有必去", "都可以"], satisfied: (brief: TripBriefDraft) => (brief.mustGo?.length ?? 0) > 0 },
  { id: "interests", question: "更偏向哪种玩法？自然风光、人文历史、美食，还是轻徒步？", quickReplies: ["自然风光", "人文历史", "美食", "轻徒步"], satisfied: (brief: TripBriefDraft) => (brief.interests?.length ?? 0) > 0 },
  { id: "avoid", question: "有没有完全不想去的地方或区域？没有就用“没有”跳过。", quickReplies: ["没有", "都行"], satisfied: (brief: TripBriefDraft) => (brief.avoid?.length ?? 0) > 0 },
];
const INTERVIEW_IDS = INTERVIEW_STEPS.map((step) => step.id);

function isForceConfirmText(text: string) {
  return /开始规划|就这样|可以了|差不多了|都确定了|其他都随意|不用再问|开始吧|就当这样|足够了/.test(text);
}

function message(role: AgentMessage["role"], content: string, kind: AgentMessage["kind"] = "text", quickReplies: string[] = []): AgentMessage {
  return { id: id("message"), role, kind, content, quickReplies, createdAt: new Date().toISOString() };
}

function chineseNumber(value: string) {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (value === "十") return 10;
  if (value.startsWith("十")) return 10 + (digits[value[1]] ?? 0);
  if (value.endsWith("十")) return (digits[value[0]] ?? 0) * 10;
  return digits[value] ?? Number.NaN;
}

function splitPlaces(value: string) {
  return value.split(/[，,、和及]|以及/).map((item) => item.replace(/[。；;].*$/, "").trim()).filter(Boolean).slice(0, 8);
}

export function extractTripBriefFallback(text: string): TripBriefDraft {
  const patch: TripBriefDraft = { confirmedFields: [] };
  const confirm = (field: TripBriefDraft["confirmedFields"][number]) => patch.confirmedFields.push(field);
  const destination = text.match(/(?:想去|准备去|打算去|到|去)([\u4e00-\u9fa5]{2,12}?)(?:玩|自驾|旅行|旅游|走|[，,。\s]|\d)/)?.[1];
  if (destination) { patch.destination = destination.replace(/一趟$/, ""); confirm("destination"); }
  const days = text.match(/([一二两三四五六七八九十\d]{1,3})\s*天/)?.[1];
  if (days) { patch.days = chineseNumber(days); confirm("days"); }
  const adults = text.match(/(\d+)\s*(?:个)?(?:大人|成人|大)(?!概)/)?.[1];
  if (adults) { patch.adults = Number(adults); confirm("adults"); }
  const children = text.match(/(\d+)\s*(?:个)?(?:孩子|儿童|小孩|小)(?!时)/)?.[1];
  if (children) { patch.children = Number(children); confirm("children"); }
  const seniors = text.match(/(\d+)\s*(?:个)?(?:老人|长辈)/)?.[1];
  if (seniors) { patch.seniors = Number(seniors); confirm("seniors"); }
  const ages = [...text.matchAll(/(?:孩子|儿童|小孩)?\s*(\d{1,2})\s*岁/g)].map((match) => Number(match[1])).filter((age) => age < 18);
  if (ages.length) { patch.childAges = ages; patch.children = Math.max(patch.children ?? 0, ages.length); confirm("childAges"); confirm("children"); }
  if (/轻松|休闲|从容/.test(text)) { patch.pace = "relaxed"; confirm("pace"); }
  else if (/紧凑|特种兵|尽量多玩/.test(text)) { patch.pace = "compact"; confirm("pace"); }
  else if (/适中|均衡/.test(text)) { patch.pace = "balanced"; confirm("pace"); }
  const interestMap = ["自然风光", "亲子", "人文历史", "美食", "摄影", "轻徒步"];
  const interests = interestMap.filter((item) => text.includes(item) || (item === "自然风光" && /雪山|草原|湖泊|自然/.test(text)) || (item === "人文历史" && /人文|历史|古城|博物馆/.test(text)));
  if (interests.length) { patch.interests = interests; confirm("interests"); }
  const maxDrive = text.match(/(?:驾驶|开车)(?:不超过|最多|控制在)?\s*(\d+(?:\.\d+)?)\s*(?:小时|h)/i)?.[1];
  if (maxDrive) { patch.maxDriveHours = Number(maxDrive); confirm("maxDriveHours"); }
  const month = text.match(/(\d{1,2})\s*月/)?.[1];
  if (month) { patch.month = `${Number(month)}月`; confirm("month"); }
  const must = text.match(/(?:必去|一定要去|想去的)(?:是|包括|：|:)?([^。；;]+)/)?.[1];
  if (must && !/^\d/.test(must)) { patch.mustGo = splitPlaces(must); confirm("mustGo"); }
  const avoid = text.match(/(?:不想去|避开|不要安排)(?:的是|：|:)?([^。；;]+)/)?.[1];
  if (avoid) { patch.avoid = splitPlaces(avoid); confirm("avoid"); }
  return patch;
}

function mergeBrief(current: TripBriefDraft, ...patches: TripBriefDraft[]) {
  const merged: TripBriefDraft = { ...current, confirmedFields: [...current.confirmedFields] };
  for (const patch of patches) {
    for (const [key, value] of Object.entries(patch)) {
      if (key !== "confirmedFields" && value !== undefined) Object.assign(merged, { [key]: value });
    }
    merged.confirmedFields = [...new Set([...merged.confirmedFields, ...patch.confirmedFields])];
  }
  return merged;
}

function missingFields(brief: TripBriefDraft) {
  const missing: string[] = [];
  if (!brief.destination || brief.destination.length < 2) missing.push("destination");
  if (!brief.days) missing.push("days");
  if ((brief.children ?? 0) > 0 && (brief.childAges?.length ?? 0) === 0) missing.push("childAges");
  return missing;
}

function questionFor(missing: string[]) {
  if (missing.includes("destination") && missing.includes("days")) return "想去哪里、准备玩几天？也可以顺手告诉我同行人员和偏好。";
  if (missing.includes("destination")) return "这次自驾想去哪个城市、省份或连续区域？";
  if (missing.includes("days")) return "你准备在目的地完整游玩几天？";
  return "孩子大约几岁？我会据此调整连续驾驶和休息时间。";
}

function toRequest(brief: TripBriefDraft): TripRequest {
  return TripRequestSchema.parse({ ...defaults, ...brief, confirmedFields: undefined });
}

function briefSummary(brief: TripBriefDraft) {
  const pace = { relaxed: "轻松", balanced: "适中", compact: "紧凑" }[brief.pace ?? "balanced"];
  const people = `${brief.adults ?? 2} 位成人${brief.children ? `、${brief.children} 位儿童` : ""}${brief.seniors ? `、${brief.seniors} 位老人` : ""}`;
  return `我整理好了：${brief.destination} · ${brief.days} 天 · ${people} · ${pace}节奏 · 单日驾驶不超过 ${brief.maxDriveHours ?? 5} 小时${brief.interests?.length ? ` · 偏好 ${brief.interests.join("、")}` : ""}${brief.mustGo?.length ? ` · 必去 ${brief.mustGo.join("、")}` : ""}。确认后我会生成两套可比较路线。`;
}

function metrics(plan: Plan) {
  const sum = summarizePlan(plan);
  return {
    distanceM: sum.distanceM,
    driveS: sum.driveS,
    tiringDays: plan.days.filter((day) => day.intensity === "tiring" || day.intensity === "not_recommended").length,
    placeCount: plan.days.reduce((count, day) => count + day.activities.filter((activity) => activity.type === "place").length, 0),
  };
}

function comparison(bundle: TripBundle) {
  return bundle.plans.map((plan, index) => {
    const value = metrics(plan);
    const stays = new Set(plan.days.map((day) => day.stay)).size;
    return `方案 ${String.fromCharCode(65 + index)}「${plan.name}」：${plan.tagline}；约 ${Math.round(value.distanceM / 1000)} 公里、${(value.driveS / 3600).toFixed(1)} 小时驾驶、${stays} 个住宿区域${value.tiringDays ? `，${value.tiringDays} 天强度偏高` : "，整体强度可控"}`;
  }).join("\n");
}

function dayFromText(text: string) {
  const raw = text.match(/第?([一二两三四五六七八九十\d]{1,3})天/)?.[1];
  return raw ? chineseNumber(raw) : 1;
}

export function interpretPlanChangeFallback(text: string, plan: Plan): PlanChangeOperation[] {
  const day = dayFromText(text);
  if (/少换酒店|减少换酒店|不想换酒店/.test(text)) {
    const stay = plan.days[0]?.stay;
    return stay ? plan.days.slice(1).filter((item) => item.stay !== stay).map((item) => ({ type: "update_stay" as const, day: item.day, stay })) : [];
  }
  const replace = text.match(/把\s*(.+?)\s*(?:换成|替换成|改成)\s*(.+?)(?:[。；;]|$)/);
  if (replace) return [{ type: "replace_place", day, placeName: replace[1].trim(), replacement: replace[2].trim() }];
  const remove = text.match(/(?:删掉|去掉|不去|移除)\s*(.+?)(?:[。；;]|$)/);
  if (remove) return [{ type: "remove_place", day, placeName: remove[1].trim() }];
  const add = text.match(/(?:加入|增加|加上|安排)\s*(.+?)(?:[。；;]|$)/);
  if (add && !/休息|时间/.test(add[1])) return [{ type: "add_place", day, placeName: add[1].trim() }];
  const stay = text.match(/(?:住在|住宿(?:改成|换到)|酒店(?:改成|换到))\s*(.+?)(?:[。；;]|$)/);
  if (stay) return [{ type: "update_stay", day, stay: stay[1].trim() }];
  const move = text.match(/把?\s*(.+?)\s*(提前|往前|推后|往后)/);
  if (move) return [{ type: "move_place", day, placeName: move[1].trim(), direction: /提前|往前/.test(move[2]) ? "earlier" : "later" }];
  if (/轻松一点|轻松些|少安排|减少景点|别太累/.test(text)) return [{ type: "lighten_day", day }];
  return [];
}

function explainPlan(text: string, plan: Plan) {
  const namedActivity = plan.days.flatMap((day) => day.activities.map((activity) => ({ day: day.day, activity }))).find(({ activity }) => text.includes(activity.place.name));
  if (namedActivity) {
    const knowledge = namedActivity.activity.place.knowledge;
    return `${namedActivity.activity.place.name}安排在第 ${namedActivity.day} 天。${knowledge.summary || "当前资料还不完整。"}${knowledge.sources.length ? `这条介绍参考了 ${knowledge.sources.length} 个来源。` : "目前没有可引用的网络来源，出发前建议再核对。"}`;
  }
  if (/累|强度|驾驶|开车/.test(text)) {
    const tired = plan.days.filter((day) => day.intensity === "tiring" || day.intensity === "not_recommended");
    return tired.length ? `当前第 ${tired.map((day) => day.day).join("、")} 天强度偏高。你可以告诉我“第几天轻松一点”，我会先给出调整预览。` : "当前各天驾驶与游玩强度都在已设置的范围内；估算路段仍建议出发前用导航复核。";
  }
  if (/为什么|原因|怎么安排/.test(text)) return `这套「${plan.name}」按少折返、控制驾驶强度和住宿衔接来排序。${plan.tagline}。你可以继续问某一天或某个景点，也可以直接描述想改什么。`;
  return "我可以解释路线安排，也可以按你的话调整某一天、景点顺序或住宿。涉及修改时，我会先给你看变化，再等你确认。";
}

export class TravelAgentService {
  constructor(
    private readonly sessions: Pick<FileAgentSessionRepository, "get" | "save"> = new FileAgentSessionRepository(),
    private readonly trips: Pick<FileTripRepository, "get" | "save"> = new FileTripRepository(),
  ) {}

  async createSession(tripId?: string) {
    const now = new Date().toISOString();
    const trip = tripId ? await this.trips.get(tripId) : null;
    const session = AgentSessionSchema.parse({
      schemaVersion: 1,
      id: id("session"),
      stage: trip ? "editing" : "collecting",
      brief: trip ? { ...trip.request, confirmedFields: ["destination", "days"] } : defaults,
      interviewQueue: trip ? [] : INTERVIEW_IDS,
      messages: [message("assistant", trip ? `已恢复你的${trip.request.destination}行程。可以继续问我路线原因，或者直接告诉我想改哪一天。` : "你好，我是去野旅行 Agent。告诉我想去哪里、玩几天、和谁同行，我会边聊边把约束整理成可执行的自驾方案。", "text", trip ? [] : ["去川西玩 5 天，2 位成人，节奏轻松", "带孩子去新疆伊犁自驾 7 天", "想做一条云南自然风光路线"])],
      tripId: trip?.id,
      createdAt: now,
      updatedAt: now,
    });
    if (trip && trip.agentSessionId !== session.id) await this.trips.save({ ...trip, agentSessionId: session.id, updatedAt: now });
    return this.sessions.save(session);
  }

  getSession(idValue: string) { return this.sessions.get(idValue); }

  private async load(idValue: string) {
    const session = await this.sessions.get(idValue);
    if (!session) throw new Error("对话已失效，请重新开始");
    return session;
  }

  private async extractBrief(text: string, current: TripBriefDraft) {
    const fallback = extractTripBriefFallback(text);
    const llm = createLlmProvider();
    if (!llm) return mergeBrief(current, fallback);
    try { return mergeBrief(current, fallback, await llm.extractTripBrief(text, current)); } catch { return mergeBrief(current, fallback); }
  }

  private async interpretChange(text: string, plan: Plan) {
    const fallback = interpretPlanChangeFallback(text, plan);
    if (fallback.length) return fallback;
    const llm = createLlmProvider();
    if (!llm) return [];
    try { return z.array(PlanChangeOperationSchema).parse(await llm.interpretPlanChange(text, plan)); } catch { return []; }
  }

  private async previewChange(bundle: TripBundle, operations: PlanChangeOperation[]): Promise<PlanChangeSet> {
    const plan = bundle.plans.find((item) => item.id === bundle.selectedPlanId) ?? bundle.plans[0];
    let days = plan.days.map((day) => ({ ...day, activities: [...day.activities] }));
    const affected = new Set<number>();
    for (const operation of operations) {
      const dayIndex = days.findIndex((day) => day.day === operation.day);
      if (dayIndex < 0) throw new Error(`方案中没有第 ${operation.day} 天`);
      const day = days[dayIndex];
      affected.add(day.day);
      if (operation.type === "remove_place" || operation.type === "replace_place" || operation.type === "move_place") {
        const activityIndex = day.activities.findIndex((activity) => activity.place.name.includes(operation.placeName) || operation.placeName.includes(activity.place.name));
        if (activityIndex < 0) throw new Error(`第 ${day.day} 天没有找到“${operation.placeName}”`);
        if (operation.type === "remove_place") day.activities.splice(activityIndex, 1);
        if (operation.type === "replace_place") {
          const place = await resolvePlace(operation.replacement, bundle.request);
          day.activities[activityIndex] = { id: id("activity"), type: "place", place, startTime: "", endTime: "", durationMin: place.knowledge.suggestedDurationMin, note: place.knowledge.playTips[0] ?? "" };
        }
        if (operation.type === "move_place") {
          const target = Math.max(0, Math.min(day.activities.length - 1, activityIndex + (operation.direction === "earlier" ? -1 : 1)));
          [day.activities[activityIndex], day.activities[target]] = [day.activities[target], day.activities[activityIndex]];
        }
      } else if (operation.type === "add_place") {
        const place = await resolvePlace(operation.placeName, bundle.request);
        day.activities.push({ id: id("activity"), type: "place", place, startTime: "", endTime: "", durationMin: place.knowledge.suggestedDurationMin, note: place.knowledge.playTips[0] ?? "" });
      } else if (operation.type === "update_stay") {
        days[dayIndex] = { ...day, stay: operation.stay, stayReason: "按本次对话调整，减少住宿或方便衔接" };
      } else if (operation.type === "lighten_day") {
        const removable = [...day.activities].reverse().find((activity) => !bundle.request.mustGo.includes(activity.place.name));
        if (!removable || day.activities.length <= 1) throw new Error(`第 ${day.day} 天已经没有可安全移除的非必去景点`);
        day.activities = day.activities.filter((activity) => activity.id !== removable.id);
      }
    }
    const draft = { ...plan, days };
    const proposedPlan = await recalculatePlan(bundle.request, draft, [...affected]);
    const labels = operations.map((operation) => {
      if (operation.type === "lighten_day") return `精简第 ${operation.day} 天`;
      if (operation.type === "update_stay") return `第 ${operation.day} 天改住 ${operation.stay}`;
      if (operation.type === "replace_place") return `把 ${operation.placeName} 换成 ${operation.replacement}`;
      if (operation.type === "add_place") return `加入 ${operation.placeName}`;
      if (operation.type === "remove_place") return `移除 ${operation.placeName}`;
      return `调整 ${operation.placeName} 的顺序`;
    });
    return {
      id: id("change"), planId: plan.id, baseVersion: plan.version, summary: labels.join("；"), affectedDays: [...affected].sort((a, b) => a - b), operations,
      before: metrics(plan), after: metrics(proposedPlan), proposedPlan, createdAt: new Date().toISOString(),
    };
  }

  async handleTurn(sessionId: string, rawInput: unknown, emit: (event: AgentEvent) => void = () => undefined) {
    const input = AgentTurnInputSchema.parse(rawInput);
    let session = await this.load(sessionId);
    emit({ type: "ack", message: "已收到" });

    if (input.type === "message") {
      session = { ...session, messages: [...session.messages, message("user", input.message)], updatedAt: new Date().toISOString() };
      await this.sessions.save(session);
      if (session.stage === "collecting" || session.stage === "ready") {
        emit({ type: "progress", message: "正在整理旅行条件" });
        const brief = await this.extractBrief(input.message, session.brief);
        const missing = missingFields(brief);
        const now = new Date().toISOString();
        if (missing.length) {
          const assistant = message("assistant", questionFor(missing), "question");
          session = { ...session, brief, interviewQueue: session.interviewQueue, stage: "collecting", messages: [...session.messages, assistant], updatedAt: now };
        } else if (session.stage === "collecting" && !isForceConfirmText(input.message)) {
          const base = session.interviewQueue;
          const remaining = base.filter((id) => { const step = INTERVIEW_STEPS.find((item) => item.id === id); return step && !step.satisfied(brief); });
          if (remaining.length) {
            const step = INTERVIEW_STEPS.find((item) => item.id === remaining[0])!;
            const assistant = message("assistant", step.question, "question", step.quickReplies);
            session = { ...session, brief, interviewQueue: remaining.slice(1), stage: "collecting", messages: [...session.messages, assistant], updatedAt: now };
          } else {
            const assistant = message("assistant", briefSummary(brief), "brief", ["开始规划"]);
            session = { ...session, brief, interviewQueue: [], stage: "ready", messages: [...session.messages, assistant], updatedAt: now };
          }
        } else {
          const assistant = message("assistant", briefSummary(brief), "brief", ["开始规划"]);
          session = { ...session, brief, interviewQueue: [], stage: "ready", messages: [...session.messages, assistant], updatedAt: now };
        }
      } else {
        const bundle = session.tripId ? await this.trips.get(session.tripId) : null;
        if (!bundle) throw new Error("没有找到当前行程，请重新生成");
        const plan = bundle.plans.find((item) => item.id === bundle.selectedPlanId) ?? bundle.plans[0];
        const operations = await this.interpretChange(input.message, plan);
        if (operations.length) {
          emit({ type: "progress", message: "正在计算调整后的路线与强度" });
          const pendingChange = await this.previewChange(bundle, operations);
          const distanceDelta = Math.round((pendingChange.after.distanceM - pendingChange.before.distanceM) / 1000);
          const assistant = message("assistant", `${pendingChange.summary}。预计总里程${distanceDelta === 0 ? "基本不变" : `${distanceDelta > 0 ? "增加" : "减少"} ${Math.abs(distanceDelta)} 公里`}，受影响：第 ${pendingChange.affectedDays.join("、")} 天。确认后才会写入 v${pendingChange.proposedPlan.version}。`, "change_preview", ["确认修改", "取消"]);
          session = { ...session, pendingChange, messages: [...session.messages, assistant], updatedAt: new Date().toISOString() };
        } else {
          session = { ...session, messages: [...session.messages, message("assistant", explainPlan(input.message, plan))], updatedAt: new Date().toISOString() };
        }
      }
      session = await this.sessions.save(session);
      emit({ type: "session", session });
      return { session };
    }

    if (input.type === "generate") {
      if (session.stage !== "ready") throw new Error("请先补齐目的地和旅行天数");
      session = await this.sessions.save({ ...session, stage: "generating", messages: [...session.messages, message("assistant", "开始规划。我会核对地点、路线和每天的驾驶强度。", "status")], updatedAt: new Date().toISOString() });
      emit({ type: "progress", message: "正在寻找值得停留的地方" });
      let bundle = await generateTrip(toRequest(session.brief));
      bundle = { ...bundle, agentSessionId: session.id };
      await this.trips.save(bundle);
      const assistant = message("assistant", `两套方案已经准备好：\n${comparison(bundle)}\n先选一套作为主方案，之后还可以继续和我调整。`, "comparison");
      session = await this.sessions.save({ ...session, stage: "comparing", tripId: bundle.id, messages: [...session.messages, assistant], updatedAt: new Date().toISOString() });
      emit({ type: "trip", trip: bundle });
      emit({ type: "session", session });
      return { session, trip: bundle };
    }

    if (!session.tripId) throw new Error("当前还没有生成行程");
    let bundle = await this.trips.get(session.tripId);
    if (!bundle) throw new Error("行程不存在或已失效");

    if (input.type === "select_plan") {
      const selected = bundle.plans.find((plan) => plan.id === input.planId);
      if (!selected) throw new Error("没有找到这个候选方案");
      bundle = await this.trips.save({ ...bundle, selectedPlanId: selected.id, updatedAt: new Date().toISOString() });
      session = await this.sessions.save({ ...session, stage: "editing", messages: [...session.messages, message("assistant", `已选择「${selected.name}」。现在可以问我为什么这样安排，或直接说“第二天轻松一点”。`)], updatedAt: new Date().toISOString() });
    } else if (input.type === "confirm_change") {
      const change = session.pendingChange;
      if (!change) throw new Error("当前没有待确认的修改");
      const current = bundle.plans.find((plan) => plan.id === change.planId);
      if (!current || current.version !== change.baseVersion) throw new Error("行程已经发生变化，请重新提出修改以生成最新预览");
      const now = new Date().toISOString();
      bundle = await this.trips.save({
        ...bundle,
        plans: bundle.plans.map((plan) => plan.id === change.planId ? change.proposedPlan : plan),
        revisions: [...bundle.revisions, { id: id("revision"), planId: change.planId, version: change.proposedPlan.version, parentVersion: change.baseVersion, source: "agent", summary: change.summary, createdAt: now, snapshot: change.proposedPlan }],
        updatedAt: now,
      });
      session = await this.sessions.save({ ...session, pendingChange: undefined, messages: [...session.messages, message("assistant", `修改已应用并保存为 v${change.proposedPlan.version}。地图、时间轴和强度提示已经同步。`)], updatedAt: now });
    } else if (input.type === "cancel_change") {
      session = await this.sessions.save({ ...session, pendingChange: undefined, messages: [...session.messages, message("assistant", "已取消这次修改，当前方案保持不变。")], updatedAt: new Date().toISOString() });
    } else if (input.type === "restore_revision") {
      const revision = bundle.revisions.find((item) => item.id === input.revisionId);
      if (!revision) throw new Error("没有找到这个历史版本");
      const current = bundle.plans.find((plan) => plan.id === revision.planId);
      if (!current) throw new Error("原方案已经不存在");
      const now = new Date().toISOString();
      const restored = { ...revision.snapshot, version: current.version + 1, createdAt: now };
      bundle = await this.trips.save({ ...bundle, plans: bundle.plans.map((plan) => plan.id === restored.id ? restored : plan), revisions: [...bundle.revisions, { id: id("revision"), planId: restored.id, version: restored.version, parentVersion: current.version, source: "restored", summary: `恢复到 v${revision.version} 的内容`, createdAt: now, snapshot: restored }], updatedAt: now });
      session = await this.sessions.save({ ...session, messages: [...session.messages, message("assistant", `已把方案内容恢复到历史版本，并保存为新的 v${restored.version}。`)], updatedAt: now });
    }

    emit({ type: "trip", trip: bundle });
    emit({ type: "session", session });
    return { session, trip: bundle };
  }
}
