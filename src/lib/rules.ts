import type { DayPlan, TripRequest, ValidationIssue } from "./domain";
import { clockToMinutes, deriveIntensity, id, minutesToClock } from "./utils";

export function applyDayRules(day: DayPlan, request: TripRequest): DayPlan {
  let cursor = 0;
  const activities = day.activities.map((activity, index) => {
    if (index > 0) cursor += (day.segments[index - 1]?.durationS ?? 0) / 60;
    const startTime = minutesToClock(request.earliestDeparture, cursor);
    cursor += activity.durationMin;
    const endTime = minutesToClock(request.earliestDeparture, cursor);
    if (request.children > 0 || request.seniors > 0) cursor += index < day.activities.length - 1 ? 20 : 0;
    return { ...activity, startTime, endTime };
  });

  const issues: ValidationIssue[] = [];
  if (day.totalDriveS / 3600 > request.maxDriveHours) {
    issues.push({ id: id("issue"), level: "error", code: "drive_limit", message: `预计驾驶超过 ${request.maxDriveHours} 小时上限` });
  }
  const finish = minutesToClock(request.earliestDeparture, cursor);
  if (clockToMinutes(request.earliestDeparture) + cursor > clockToMinutes(request.latestArrival)) {
    issues.push({ id: id("issue"), level: "warning", code: "late_arrival", message: `预计 ${finish} 结束，晚于设置的 ${request.latestArrival}` });
  }
  if (day.segments.some((segment) => segment.status !== "exact")) {
    issues.push({ id: id("issue"), level: "info", code: "estimated_route", message: "部分路段为估算值，请出发前再次核对导航" });
  }
  const placeCount = activities.filter((item) => item.type === "place").length;
  return {
    ...day,
    activities,
    issues,
    intensity: issues.some((item) => item.code === "drive_limit" || item.code === "late_arrival") ? "not_recommended" : deriveIntensity(day.totalDriveS, placeCount, request),
  };
}
