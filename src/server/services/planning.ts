import type { Activity, DayPlan, Place, Plan, PlanOutline, TripBundle, TripRequest } from "@/lib/domain";
import { PlanOutlineSchema, TripBundleSchema, TripRequestSchema } from "@/lib/domain";
import { applyDayRules } from "@/lib/rules";
import { isConcretePlace, requireEndpoints, routeSafety } from "@/lib/route-safety";
import { clockToMinutes, haversine, id } from "@/lib/utils";
import { FilePlaceRepository } from "../repositories/files";
import { createLlmProvider, createPlanningAdvisor, type PlanDraft, type PlanningAdvisor } from "../providers/llm";
import { geocodeOrEstimate, OsmMapProvider } from "../providers/map";
import { enrichKnowledge } from "./enrichment";

function fallbackDraft(request: TripRequest): PlanDraft {
  const must = request.mustGo.length ? request.mustGo : [
    `${request.destination}博物馆`,
    `${request.destination}代表景区`,
    `${request.destination}古城`,
    `${request.destination}自然公园`,
  ];
  const createDays = (shift: number) => Array.from({ length: request.days }, (_, index) => {
    const first = must[(index + shift) % must.length];
    const second = must.length > 1 && request.pace !== "relaxed" ? must[(index + shift + 1) % must.length] : undefined;
    const title = index === 0 && request.startPoint
      ? `从${request.startPoint}出发，前往${request.destination}`
      : index === request.days - 1 && request.endPoint
        ? `返回${request.endPoint}，收尾行程`
        : index === 0
          ? `抵达${request.destination}，从容展开`
          : `${request.destination} · 第${index + 1}日探索`;
    return {
      title,
      places: [...new Set([first, second].filter((value): value is string => Boolean(value)))],
      stay: request.endPoint && index === request.days - 1 ? request.endPoint : request.destination,
      stayReason: index === request.days - 1 ? "方便结束目的地内行程" : "减少换酒店和次日折返",
    };
  });
  return {
    plans: [
      { name: "经典行程", tagline: "经典体验与驾驶强度之间取得平衡", days: createDays(0) },
    ],
  };
}

async function mapLimit<T, R>(values: T[], limit: number, handler: (value: T, index: number) => Promise<R>) {
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await handler(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

async function resolvePlaces(names: string[], request: TripRequest) {
  const repository = new FilePlaceRepository();
  const map = new OsmMapProvider();
  const destination = await map.geocodeDestination(request.destination);
  if (!destination) throw new Error("无法确认目的地区域，请补充省份及城市名称后重试");
  const center = destination.location;
  const unique = [...new Set(names)];
  const places: Place[] = [];

  for (let index = 0; index < unique.length; index++) {
    const name = unique[index];
    if (!isConcretePlace(name)) throw new Error(`“${name}”不是明确地点，请提供具体景点或城市名称`);
    const existing = await repository.findByName(name);
    const regionLimit = request.destination.length <= 3 ? 1_500_000 : 450_000;
    const distanceFromCenter = existing ? haversine(existing.location, center) : Number.POSITIVE_INFINITY;
    if (existing && existing.locationStatus === "verified" && existing.address.includes(name) && Date.parse(existing.knowledge.expiresAt) > Date.now() && distanceFromCenter <= regionLimit && (existing.name === request.destination || distanceFromCenter > 2_000)) {
      places.push(existing);
      continue;
    }
    const geocoded = await geocodeOrEstimate(map, name, request.destination, center, index);
    if (!geocoded.verified) throw new Error(`无法确认“${name}”的位置，请补充所在城市或更换具体地点后重试；本次未生成估算坐标路线。`);
    const knowledge = existing?.knowledge ?? await enrichKnowledge(name);
    const place: Place = {
      id: existing?.id ?? id("place"),
      name,
      aliases: existing?.aliases ?? [],
      address: geocoded.address,
      category: existing?.category ?? "景点",
      location: geocoded.location,
      locationStatus: geocoded.verified ? "verified" : "estimated",
      knowledge,
    };
    places.push(await repository.save(place));
  }
  return new Map(places.map((place) => [place.name, place]));
}

/** 剥离住宿地描述中的括号注释（“喀纳斯景区（贾登峪或景区内）” → “喀纳斯景区”），用于匹配既有景点。 */
function stripParenthetical(name: string) {
  const match = name.match(/^(.+?)[（(]/);
  return match ? match[1].trim() : name;
}

/**
 * 解析“出发点/住宿地”地名（首日出发地 = startPoint/destination；之后 = 前一日 stay；当日住宿地 = 当日 stay）为 Place。
 * 优先在已解析景点与已有入库 Place 中匹配（精确 / 剥括号 / 别名），失败才走 geocode 兜底并入库。
 * 解析失败时明确中断，不能静默跳过出发或入住路段。
 */
async function resolveOriginPlace(name: string, request: TripRequest, knownPlaces: Iterable<Place>): Promise<Place | null> {
  if (!isConcretePlace(name)) throw new Error(`“${name || "未填写"}”不是明确的出发、住宿或结束地点，请补充城市或酒店名`);
  const base = stripParenthetical(name);
  const repository = new FilePlaceRepository();
  for (const candidate of [name, base]) {
    for (const place of knownPlaces) {
      if (place.locationStatus === "verified" && (place.name === candidate || place.aliases.includes(candidate))) return place;
    }
    const existing = await repository.findByName(candidate);
    if (existing?.locationStatus === "verified" && existing.address.includes(candidate)) return existing;
  }
  try {
    const map = new OsmMapProvider();
    const destination = await map.geocodeDestination(request.destination);
    if (!destination) throw new Error("目的地区域尚未确认");
    const center = destination.location;
    const geocoded = await geocodeOrEstimate(map, base, request.destination, center, 0);
    if (!geocoded.verified) throw new Error("地点位置未确认");
    const place: Place = {
      id: id("place"), name: base, aliases: [], address: geocoded.address,
      category: "住宿", location: geocoded.location,
      locationStatus: geocoded.verified ? "verified" : "estimated",
      knowledge: {
        summary: `${base}（住宿点）`, highlights: [], playTips: [], suggestedDurationMin: 60, suitableFor: [],
        cautions: [], status: "auto", updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(), lockedFields: [], sources: [],
      },
    };
    return await repository.save(place);
  } catch {
    throw new Error(`无法确认“${name}”的位置，请补充完整城市、酒店或车站名称后重试`);
  }
}

/**
 * 组装每日路线：首段固定为“当日出发地 → 当天第一个景点”，
 * 末段在“当日住宿地 ≠ 最后景点（且相距 > 3km）”时追加“最后景点 → 住宿地”，
 * 保证路线从住宿地出发、到住宿地收尾，前后天闭环衔接（前一天住 A，后一天从 A 出发）。
 * 返回 { routePlaces, segments }。
 */
async function assembleRoute(inputPlaces: Place[], origin: Place | undefined, stay: Place | undefined, map: OsmMapProvider) {
  const routePlaces = [...inputPlaces];
  if (origin && origin.name !== routePlaces[0]?.name) routePlaces.unshift(origin);
  const lastActivity = inputPlaces[inputPlaces.length - 1];
  if (stay && lastActivity && stay.name !== lastActivity.name && haversine(stay.location, lastActivity.location) / 1000 > 3) {
    routePlaces.push(stay);
  }
  const segments = await Promise.all(routePlaces.slice(0, -1).map((from, segmentIndex) => map.calculateRoute(from, routePlaces[segmentIndex + 1])));
  return { routePlaces, segments };
}

export async function resolvePlace(name: string, request: TripRequest) {
  const places = await resolvePlaces([name], request);
  const place = places.get(name);
  if (!place) throw new Error(`没有找到“${name}”的可用地点资料`);
  return place;
}

async function buildPlan(draft: PlanDraft["plans"][number], places: Map<string, Place>, request: TripRequest, advisor: PlanningAdvisor | null, confirmed = false): Promise<Plan> {
  const map = new OsmMapProvider();
  const dayDrafts = confirmed ? draft.days : draft.days.slice(0, request.days).map((day, index) => index === request.days - 1 ? { ...day, stay: request.endPoint!, stayReason: "行程在已确认的结束地点收尾" } : day);

  // LLM 时长分配（每套方案一次批量调用；失败回退到景点库建议时长）。
  const durationMap = new Map<number, Map<string, number>>();
  if (advisor) {
    try {
      const inputs = dayDrafts.map((dayDraft, dayIndex) => ({
        day: dayIndex + 1,
        places: dayDraft.places.map((name) => places.get(name)).filter((place): place is Place => Boolean(place)).map((place) => ({
          name: place.name,
          category: place.category,
          suggestedDurationMin: place.knowledge.suggestedDurationMin,
          summary: place.knowledge.summary,
          suitableFor: place.knowledge.suitableFor,
        })),
      }));
      for (const entry of await advisor.allocateDurations(inputs, request)) {
        durationMap.set(entry.day, new Map(Object.entries(entry.durations)));
      }
    } catch {
      // LLM 不可用时使用 place.knowledge.suggestedDurationMin。
    }
  }

  const days = await mapLimit(dayDrafts, 2, async (dayDraft, dayIndex) => {
    const dayPlaces = dayDraft.places.map((name) => places.get(name)).filter((place): place is Place => Boolean(place));
    const dayDurations = durationMap.get(dayIndex + 1);
    const initialActivities: Activity[] = dayPlaces.map((place) => ({
      id: id("activity"), type: "place", place, startTime: "", endTime: "", durationMin: dayDurations?.get(place.name) ?? place.knowledge.suggestedDurationMin, note: place.knowledge.playTips[0] ?? "",
    }));
    const assemble = async (inputActivities: Activity[]) => {
      // 当日出发地：首日 = startPoint ?? destination；之后 = 前一日 stay；住宿地 = 当日 stay（保证前后天路线闭环）
      const originName = dayIndex === 0 ? (request.startPoint ?? request.destination) : dayDrafts[dayIndex - 1].stay;
      const origin = await resolveOriginPlace(originName, request, places.values());
      const stay = await resolveOriginPlace(dayDraft.stay, request, places.values());
      const { routePlaces, segments } = await assembleRoute(inputActivities.map((activity) => activity.place), origin ?? undefined, stay ?? undefined, map);
      const totalDistanceM = segments.reduce((sum, segment) => sum + segment.distanceM, 0);
      const totalDriveS = segments.reduce((sum, segment) => sum + segment.durationS, 0);
      const familyBuffer = (request.children > 0 || request.seniors > 0) ? Math.max(0, routePlaces.length - 1) * 20 : 0;
      const availableVisitMinutes = Math.max(60 * inputActivities.length, clockToMinutes(request.latestArrival) - clockToMinutes(request.earliestDeparture) - totalDriveS / 60 - familyBuffer);
      const perPlaceCap = Math.max(60, Math.min(request.pace === "relaxed" ? 240 : 210, Math.floor(availableVisitMinutes / Math.max(1, inputActivities.length))));
      // 物理保险丝：LLM 给的时长必须过代码上下限校验（下限 30，上限 perPlaceCap）。
      const activities = inputActivities.map((activity) => ({ ...activity, durationMin: Math.max(30, Math.min(activity.durationMin, perPlaceCap)) }));
      return applyDayRules({
        id: id("day"), day: dayIndex + 1, title: dayDraft.title, activities, segments, stay: dayDraft.stay, stayReason: dayDraft.stayReason,
        totalDistanceM, totalDriveS, intensity: "relaxed", issues: [],
      }, request);
    };
    let finalized = await assemble(initialActivities);
    if (confirmed && finalized.intensity === "not_recommended") {
      finalized.issues.push({ id: id("issue"), level: "info", code: "outline_preserved", message: "已保留确认草案的全部地点、顺序和住宿。需要调整时，请提出修改，查看变化预览并确认后再应用。" });
    }
    if (!confirmed && finalized.intensity === "not_recommended" && initialActivities.length > 1) {
      // 砍景点：LLM 决策移除哪个并给出理由；失败回退到原启发式（非必去中最后一个）。
      let removal: { name: string; reason: string } | null = null;
      if (advisor) {
        try {
          const choice = await advisor.chooseRemoval({
            day: dayIndex + 1,
            driveHours: finalized.totalDriveS / 3600,
            maxDriveHours: request.maxDriveHours,
            family: request.children > 0 || request.seniors > 0,
            candidates: initialActivities
              .map((activity, position) => ({ activity, position }))
              .filter(({ activity }) => !request.mustGo.includes(activity.place.name))
              .map(({ activity, position }) => ({ name: activity.place.name, category: activity.place.category, isMustGo: false, suggestedDurationMin: activity.place.knowledge.suggestedDurationMin, position: position + 1 })),
          });
          if (choice && initialActivities.some((activity) => activity.place.name === choice.place)) removal = { name: choice.place, reason: choice.reason };
        } catch {
          // 回退启发式。
        }
      }
      let removableIndex = removal ? initialActivities.findIndex((activity) => activity.place.name === removal!.name) : -1;
      if (removableIndex < 0) removableIndex = initialActivities.findLastIndex((activity) => !request.mustGo.includes(activity.place.name));
      if (removableIndex >= 0) {
        finalized = await assemble(initialActivities.filter((_, activityIndex) => activityIndex !== removableIndex));
        const suffix = removal?.reason ? `：${removal.reason}` : "，避免当天驾驶或游玩超时";
        finalized.issues.push({ id: id("issue"), level: "info", code: "auto_repair", message: `已自动移除“${initialActivities[removableIndex].place.name}”${suffix}` });
      }
    }
    return finalized;
  });

  // LLM 强度评估（每套方案一次批量调用；硬校验 drive_limit/late_arrival 由代码先算死，LLM 不能推翻）。
  let evaluatedDays = days;
  if (advisor) {
    try {
      const facts = days.map((day) => ({
        day: day.day,
        placeNames: day.activities.filter((item) => item.type === "place").map((item) => item.place.name),
        driveHours: day.totalDriveS / 3600,
        placeCount: day.activities.filter((item) => item.type === "place").length,
        finishTime: day.activities.length ? day.activities[day.activities.length - 1].endTime : request.earliestDeparture,
      }));
      const evaluations = new Map((await advisor.evaluateDays(facts, request)).map((entry) => [entry.day, entry]));
      evaluatedDays = days.map((day) => {
        const evaluation = evaluations.get(day.day);
        if (!evaluation) return day;
        const hardViolation = day.issues.some((issue) => issue.level === "error" || issue.code === "late_arrival");
        if (hardViolation) return day; // 硬校验保险丝：代码结论优先。
        return {
          ...day,
          intensity: evaluation.intensity,
          issues: [...day.issues, { id: id("issue"), level: "info" as const, code: "intensity_eval", message: `强度评估：${evaluation.reason}` }],
        };
      });
    } catch {
      // 保留 applyDayRules 的规则强度。
    }
  }

  return {
    id: id("plan"), name: draft.name, tagline: draft.tagline, accent: "vermillion", version: 1,
    createdAt: new Date().toISOString(), days: evaluatedDays,
  };
}

export async function generateTrip(input: unknown, confirmedOutline?: PlanOutline): Promise<TripBundle> {
  const request = TripRequestSchema.parse(input);
  requireEndpoints(request);
  const outline = confirmedOutline ? PlanOutlineSchema.parse(confirmedOutline) : undefined;
  if (outline) {
    if (outline.days.length !== request.days || outline.days.some((day, index) => day.day !== index + 1 || !day.places.length)) {
      throw new Error("草案的天数或每日安排与当前需求不一致，请先更新草案并重新确认");
    }
    if (outline.days.at(-1)?.stay.trim() !== request.endPoint?.trim()) {
      throw new Error(`草案最后一天的住宿/结束地点“${outline.days.at(-1)?.stay}”与当前结束地点“${request.endPoint}”不一致。请先调整草案并重新确认，不会自动替换已确认地点。`);
    }
    for (const day of outline.days) {
      if (!isConcretePlace(day.stay) || day.places.some((name) => !isConcretePlace(name))) throw new Error(`草案第 ${day.day} 天含未明确的地点，请先补充具体地点并重新确认`);
    }
  }
  const llm = outline ? null : createLlmProvider();
  let draft = fallbackDraft(request);
  let llmLive = false;
  if (llm) {
    try {
      draft = await llm.generatePlans(request);
      llmLive = true;
    } catch {
      // 保留失败状态，下方明确报错，不发布占位景点路线。
    }
  }
  if (outline) {
    draft = { plans: [{ name: `${request.destination} · 已确认草案 v${outline.version}`, tagline: outline.summary, days: outline.days.map((day) => ({ title: day.title, places: [...day.places], stay: day.stay, stayReason: `沿用已确认草案 v${outline.version} 的安排` })) }] };
  } else if (!llmLive) throw new Error("详细规划服务暂时不可用，请稍后重试；不会用占位景点生成正式路线。草案可继续保留和调整。");
  const allNames = draft.plans.flatMap((plan) => plan.days.flatMap((day) => day.places));
  const places = await resolvePlaces(allNames, request);
  const advisor = createPlanningAdvisor();
  const plans = await mapLimit(draft.plans.slice(0, 1), 1, (plan) => buildPlan(plan, places, request, advisor, Boolean(outline)));
  for (const plan of plans) {
    if (routeSafety(plan, request).blocked) {
      plan.name = `${request.destination} · 待调整方案`;
      plan.tagline = "存在未满足的旅行约束，请调整后再确定行程";
    }
  }
  const now = new Date().toISOString();
  return TripBundleSchema.parse({
    schemaVersion: 2,
    id: id("trip"),
    confirmedOutline: outline,
    sourceOutlineVersion: outline?.version,
    request,
    plans,
    selectedPlanId: plans[0].id,
    sourceMode: outline ? "mixed" : llmLive && process.env.TAVILY_API_KEY ? "live" : llmLive || process.env.TAVILY_API_KEY ? "mixed" : "demo",
    revisions: plans.map((plan) => ({
      id: id("revision"), planId: plan.id, version: plan.version, source: "generated", summary: outline ? `基于确认草案 v${outline.version} 计算详细方案` : "首次生成方案", createdAt: now, snapshot: plan,
    })),
    createdAt: now,
    updatedAt: now,
  });
}

export async function recalculatePlan(requestInput: unknown, planInput: Plan, affectedDays?: number[]): Promise<Plan> {
  const request = TripRequestSchema.parse(requestInput);
  requireEndpoints(request);
  const map = new OsmMapProvider();
  const affected = affectedDays ? new Set(affectedDays.flatMap((day) => [day, day + 1])) : null;
  const allPlaces = planInput.days.flatMap((day) => day.activities.filter((item) => item.type === "place").map((item) => item.place));
  const days = await mapLimit(planInput.days, 2, async (day, dayIndex) => {
    if (affected && !affected.has(day.day)) return day;
    const places = day.activities.filter((item) => item.type === "place").map((item) => item.place);
    // 当日出发地：首日 = startPoint ?? destination；之后 = 前一日 stay；住宿地 = 当日 stay（保证前后天路线闭环）
    const originName = dayIndex === 0 ? (request.startPoint ?? request.destination) : planInput.days[dayIndex - 1].stay;
    const origin = await resolveOriginPlace(originName, request, allPlaces);
    const stay = await resolveOriginPlace(day.stay, request, allPlaces);
    const { segments } = await assembleRoute(places, origin ?? undefined, stay ?? undefined, map);
    return applyDayRules({
      ...day,
      segments,
      totalDistanceM: segments.reduce((sum, segment) => sum + segment.distanceM, 0),
      totalDriveS: segments.reduce((sum, segment) => sum + segment.durationS, 0),
    }, request);
  });
  return { ...planInput, version: planInput.version + 1, createdAt: new Date().toISOString(), days };
}
