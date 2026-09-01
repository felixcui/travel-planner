import type { Activity, DayPlan, Place, Plan, TripBundle, TripRequest } from "@/lib/domain";
import { TripBundleSchema, TripRequestSchema } from "@/lib/domain";
import { applyDayRules } from "@/lib/rules";
import { clockToMinutes, haversine, id } from "@/lib/utils";
import { FilePlaceRepository } from "../repositories/files";
import { createLlmProvider, createPlanningAdvisor, type PlanDraft, type PlanningAdvisor } from "../providers/llm";
import { geocodeOrEstimate, OsmMapProvider } from "../providers/map";
import { enrichKnowledge } from "./enrichment";

const DEFAULT_CENTER = { lat: 35.8617, lng: 104.1954 };

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
  const center = destination?.location ?? DEFAULT_CENTER;
  const unique = [...new Set(names)];
  const places: Place[] = [];

  for (let index = 0; index < unique.length; index++) {
    const name = unique[index];
    const existing = await repository.findByName(name);
    const regionLimit = request.destination.length <= 3 ? 1_500_000 : 450_000;
    const distanceFromCenter = existing ? haversine(existing.location, center) : Number.POSITIVE_INFINITY;
    if (existing && Date.parse(existing.knowledge.expiresAt) > Date.now() && distanceFromCenter <= regionLimit && (existing.name === request.destination || distanceFromCenter > 2_000)) {
      places.push(existing);
      continue;
    }
    const geocoded = await geocodeOrEstimate(map, name, request.destination, center, index);
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

export async function resolvePlace(name: string, request: TripRequest) {
  const places = await resolvePlaces([name], request);
  const place = places.get(name);
  if (!place) throw new Error(`没有找到“${name}”的可用地点资料`);
  return place;
}

async function buildPlan(draft: PlanDraft["plans"][number], places: Map<string, Place>, request: TripRequest, advisor: PlanningAdvisor | null): Promise<Plan> {
  const map = new OsmMapProvider();
  const dayDrafts = draft.days.slice(0, request.days);

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
      const routePlaces = inputActivities.map((activity) => activity.place);
      const segments = await Promise.all(routePlaces.slice(0, -1).map((from, segmentIndex) => map.calculateRoute(from, routePlaces[segmentIndex + 1])));
      const totalDistanceM = segments.reduce((sum, segment) => sum + segment.distanceM, 0);
      const totalDriveS = segments.reduce((sum, segment) => sum + segment.durationS, 0);
      const familyBuffer = (request.children > 0 || request.seniors > 0) ? Math.max(0, inputActivities.length - 1) * 20 : 0;
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
    if (finalized.intensity === "not_recommended" && initialActivities.length > 1) {
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
        const hardViolation = day.issues.some((issue) => issue.code === "drive_limit" || issue.code === "late_arrival");
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

export async function generateTrip(input: unknown): Promise<TripBundle> {
  const request = TripRequestSchema.parse(input);
  const llm = createLlmProvider();
  let draft = fallbackDraft(request);
  let llmLive = false;
  if (llm) {
    try {
      draft = await llm.generatePlans(request);
      llmLive = true;
    } catch {
      // Coding Plan 不可用时返回明确标记的降级方案。
    }
  }
  const allNames = draft.plans.flatMap((plan) => plan.days.flatMap((day) => day.places));
  const places = await resolvePlaces(allNames, request);
  const advisor = createPlanningAdvisor();
  const plans = await mapLimit(draft.plans.slice(0, 1), 1, (plan) => buildPlan(plan, places, request, advisor));
  const now = new Date().toISOString();
  return TripBundleSchema.parse({
    schemaVersion: 2,
    id: id("trip"),
    request,
    plans,
    selectedPlanId: plans[0].id,
    sourceMode: llmLive && process.env.TAVILY_API_KEY ? "live" : llmLive || process.env.TAVILY_API_KEY ? "mixed" : "demo",
    revisions: plans.map((plan) => ({
      id: id("revision"), planId: plan.id, version: plan.version, source: "generated", summary: "首次生成方案", createdAt: now, snapshot: plan,
    })),
    createdAt: now,
    updatedAt: now,
  });
}

export async function recalculatePlan(requestInput: unknown, planInput: Plan, affectedDays?: number[]): Promise<Plan> {
  const request = TripRequestSchema.parse(requestInput);
  const map = new OsmMapProvider();
  const affected = affectedDays ? new Set(affectedDays) : null;
  const days = await mapLimit(planInput.days, 2, async (day) => {
    if (affected && !affected.has(day.day)) return day;
    const places = day.activities.filter((item) => item.type === "place").map((item) => item.place);
    const segments = await Promise.all(places.slice(0, -1).map((from, index) => map.calculateRoute(from, places[index + 1])));
    return applyDayRules({
      ...day,
      segments,
      totalDistanceM: segments.reduce((sum, segment) => sum + segment.distanceM, 0),
      totalDriveS: segments.reduce((sum, segment) => sum + segment.durationS, 0),
    }, request);
  });
  return { ...planInput, version: planInput.version + 1, createdAt: new Date().toISOString(), days };
}
