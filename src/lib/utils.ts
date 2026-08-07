import type { Coordinate, DayPlan, TripRequest } from "./domain";

export const id = (prefix: string) => `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;

export function formatHours(seconds: number) {
  return `${(seconds / 3600).toFixed(1)}h`;
}

export function formatDuration(seconds: number) {
  const total = Math.round(seconds / 60);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (!hours) return `${minutes}分钟`;
  return minutes ? `${hours}小时${minutes}分` : `${hours}小时`;
}

export function formatDistance(meters: number) {
  return meters < 1000 ? `${Math.round(meters)}m` : `${Math.round(meters / 1000)}km`;
}

export function haversine(a: Coordinate, b: Coordinate) {
  const radius = 6_371_000;
  const rad = (value: number) => (value * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const lat1 = rad(a.lat);
  const lat2 = rad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
}

export function minutesToClock(base: string, offset: number) {
  const [hours, minutes] = base.split(":").map(Number);
  const total = hours * 60 + minutes + Math.round(offset);
  const dayPrefix = total >= 1440 ? "次日 " : "";
  return `${dayPrefix}${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function clockToMinutes(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

export function deriveIntensity(driveS: number, placeCount: number, request: TripRequest) {
  const driveHours = driveS / 3600;
  const familyPenalty = request.children > 0 || request.seniors > 0 ? 0.75 : 0;
  if (driveHours > request.maxDriveHours || driveHours + familyPenalty > 6.5) return "not_recommended" as const;
  if (driveHours + familyPenalty > 5 || (driveHours > 3.5 && placeCount > 2)) return "tiring" as const;
  if (driveHours > 3 || placeCount > 2) return "balanced" as const;
  return "relaxed" as const;
}

export function summarizePlan(plan: { days: DayPlan[] }) {
  return plan.days.reduce(
    (sum, day) => ({
      distanceM: sum.distanceM + day.totalDistanceM,
      driveS: sum.driveS + day.totalDriveS,
      places: sum.places + day.activities.filter((item) => item.type === "place").length,
    }),
    { distanceM: 0, driveS: 0, places: 0 },
  );
}

export function deterministicOffset(seed: string, index: number) {
  const value = `${seed}:${index}`;
  let first = 2166136261; let second = 2246822519;
  for (let cursor = 0; cursor < value.length; cursor++) { first = Math.imul(first ^ value.charCodeAt(cursor), 16777619); second = Math.imul(second ^ value.charCodeAt(cursor), 3266489917); }
  const lat = ((first >>> 0) / 0xffffffff - 0.5) * 1.2;
  const lng = ((second >>> 0) / 0xffffffff - 0.5) * 1.2;
  return { lat, lng };
}
