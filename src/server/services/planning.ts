import type { Activity, DayPlan, Place, Plan, TripBundle, TripRequest } from "@/lib/domain";
import { TripBundleSchema, TripRequestSchema } from "@/lib/domain";
import { applyDayRules } from "@/lib/rules";
import { clockToMinutes, haversine, id } from "@/lib/utils";
import { FilePlaceRepository } from "../repositories/files";
import { createLlmProvider, type PlanDraft } from "../providers/llm";
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
    return {
      title: index === 0 ? `抵达${request.destination}，从容展开` : `${request.destination} · 第${index + 1}日探索`,
      places: [...new Set([first, second].filter((value): value is string => Boolean(value)))],
      stay: request.endPoint && index === request.days - 1 ? request.endPoint : request.destination,
      stayReason: index === request.days - 1 ? "方便结束目的地内行程" : "减少换酒店和次日折返",
    };
  });
  return {
    plans: [
      { name: "均衡经典", tagline: "经典体验与驾驶强度之间取得平衡", days: createDays(0) },
      { name: "从容探索", tagline: "换一种顺序，留出更多家庭休息时间", days: createDays(1) },
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
  const destination = await map.geocode(request.destination, "中国");
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

async function buildPlan(draft: PlanDraft["plans"][number], index: number, places: Map<string, Place>, request: TripRequest): Promise<Plan> {
  const map = new OsmMapProvider();
  const days = await mapLimit(draft.days.slice(0, request.days), 2, async (dayDraft, dayIndex) => {
    const dayPlaces = dayDraft.places.map((name) => places.get(name)).filter((place): place is Place => Boolean(place));
    const initialActivities: Activity[] = dayPlaces.map((place) => ({
      id: id("activity"), type: "place", place, startTime: "", endTime: "", durationMin: place.knowledge.suggestedDurationMin, note: place.knowledge.playTips[0] ?? "",
    }));
    const assemble = async (inputActivities: Activity[]) => {
      const routePlaces = inputActivities.map((activity) => activity.place);
      const segments = await Promise.all(routePlaces.slice(0, -1).map((from, segmentIndex) => map.calculateRoute(from, routePlaces[segmentIndex + 1])));
      const totalDistanceM = segments.reduce((sum, segment) => sum + segment.distanceM, 0);
      const totalDriveS = segments.reduce((sum, segment) => sum + segment.durationS, 0);
      const familyBuffer = (request.children > 0 || request.seniors > 0) ? Math.max(0, inputActivities.length - 1) * 20 : 0;
      const availableVisitMinutes = Math.max(60 * inputActivities.length, clockToMinutes(request.latestArrival) - clockToMinutes(request.earliestDeparture) - totalDriveS / 60 - familyBuffer);
      const perPlaceCap = Math.max(60, Math.min(request.pace === "relaxed" ? 240 : 210, Math.floor(availableVisitMinutes / Math.max(1, inputActivities.length))));
      const activities = inputActivities.map((activity) => ({ ...activity, durationMin: Math.min(activity.durationMin, perPlaceCap) }));
      return applyDayRules({
        id: id("day"), day: dayIndex + 1, title: dayDraft.title, activities, segments, stay: dayDraft.stay, stayReason: dayDraft.stayReason,
        totalDistanceM, totalDriveS, intensity: "relaxed", issues: [],
      }, request);
    };
    let finalized = await assemble(initialActivities);
    if (finalized.intensity === "not_recommended" && initialActivities.length > 1) {
      const removableIndex = initialActivities.findLastIndex((activity) => !request.mustGo.includes(activity.place.name));
      if (removableIndex >= 0) {
        finalized = await assemble(initialActivities.filter((_, activityIndex) => activityIndex !== removableIndex));
        finalized.issues.push({ id: id("issue"), level: "info", code: "auto_repair", message: `已自动移除“${initialActivities[removableIndex].place.name}”，避免当天驾驶或游玩超时` });
      }
    }
    return finalized;
  });
  return {
    id: id("plan"), name: draft.name, tagline: draft.tagline, accent: index === 0 ? "vermillion" : "pine", version: 1,
    createdAt: new Date().toISOString(), days,
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
  const plans = await mapLimit(draft.plans.slice(0, 2), 2, (plan, index) => buildPlan(plan, index, places, request));
  const now = new Date().toISOString();
  return TripBundleSchema.parse({
    schemaVersion: 1,
    id: id("trip"),
    request,
    plans,
    selectedPlanId: plans[0].id,
    sourceMode: llmLive && process.env.TAVILY_API_KEY ? "live" : llmLive || process.env.TAVILY_API_KEY ? "mixed" : "demo",
    createdAt: now,
    updatedAt: now,
  });
}

export async function recalculatePlan(requestInput: unknown, planInput: Plan): Promise<Plan> {
  const request = TripRequestSchema.parse(requestInput);
  const map = new OsmMapProvider();
  const days = await mapLimit(planInput.days, 2, async (day) => {
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
