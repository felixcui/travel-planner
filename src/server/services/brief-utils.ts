import { TripRequestSchema } from "@/lib/domain";
import type { TripBriefDraft, TripRequest } from "@/lib/domain";

export const briefDefaults: TripBriefDraft = {
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

export function mergeBrief(current: TripBriefDraft, ...patches: TripBriefDraft[]) {
  const merged: TripBriefDraft = { ...current, confirmedFields: [...current.confirmedFields] };
  for (const patch of patches) {
    for (const [key, value] of Object.entries(patch)) {
      if (key !== "confirmedFields" && value !== undefined) Object.assign(merged, { [key]: value });
    }
    merged.confirmedFields = [...new Set([...merged.confirmedFields, ...patch.confirmedFields])];
  }
  return merged;
}

export function missingFields(brief: TripBriefDraft) {
  const missing: string[] = [];
  if (!brief.destination || brief.destination.length < 2) missing.push("destination");
  if (!brief.days) missing.push("days");
  if ((brief.children ?? 0) > 0 && (brief.childAges?.length ?? 0) === 0) missing.push("childAges");
  return missing;
}

export function toRequest(brief: TripBriefDraft): TripRequest {
  return TripRequestSchema.parse({ ...briefDefaults, ...brief, confirmedFields: undefined });
}
