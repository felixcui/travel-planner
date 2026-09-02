import type { DayPlan, TripRequest, ValidationIssue } from "./domain";
import { clockToMinutes, deriveIntensity, id, minutesToClock } from "./utils";

export function applyDayRules(day: DayPlan, request: TripRequest): DayPlan {
  // 结构说明：旧数据 segments 数 = 景点数 - 1（仅景点间，无出发/入住段）；
  // 新结构首段为“当日出发地 → 当天第一个景点”（segments 数 = 景点数），
  // 闭环结构再追加末段“最后景点 → 当日住宿地”（segments 数 = 景点数 + 1）。
  // 到达第 i 个景点前：有出发段则累加 segments[i]，否则累加 segments[i-1]。
  const placeActivities = day.activities.filter((item) => item.type === "place");
  const withOriginSegment = day.segments.length >= placeActivities.length;
  let cursor = 0;
  let placeIndex = 0;
  const activities = day.activities.map((activity, index) => {
    if (activity.type === "place") {
      if (withOriginSegment) cursor += (day.segments[placeIndex]?.durationS ?? 0) / 60;
      else if (placeIndex > 0) cursor += (day.segments[placeIndex - 1]?.durationS ?? 0) / 60;
      placeIndex += 1;
    }
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
