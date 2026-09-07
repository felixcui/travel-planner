import type { Plan, TripRequest } from "./domain";

export function isConcretePlace(name?: string): boolean {
  const value = name?.trim() ?? "";
  return value.length >= 2 && !/回家|返程|返回|出发地|目的地|待定|待确认|待补充|自由活动|自行安排|灵活安排|代表景区|当地|不住宿|不留宿|结束行程/.test(value);
}

export function requireEndpoints(request: TripRequest) {
  const missing = [!isConcretePlace(request.startPoint) && "出发地点", !isConcretePlace(request.endPoint) && "结束地点"].filter(Boolean);
  if (missing.length) throw new Error(`请先补充具体的${missing.join("和")}（城市、车站或酒店名），例如“从成都出发，最后回到成都”；不能把“回家”当作地图地点。`);
}

// Read-time checks protect old saved trips too.
export function routeSafety(plan: Plan, request: TripRequest, selectedDayId?: string) {
  const checked = selectedDayId ? plan.days.filter((day) => day.id === selectedDayId) : plan.days;
  const problems: string[] = [];
  if (!isConcretePlace(request.startPoint) || !isConcretePlace(request.endPoint)) problems.push("请明确真实出发和结束地点");
  if (plan.days.length !== request.days) problems.push("行程天数与需求不一致");
  const names = plan.days.flatMap((day) => day.activities.map((activity) => activity.place.name));
  const missing = request.mustGo.filter((name) => !names.some((actual) => actual.includes(name) || name.includes(actual)));
  if (missing.length) problems.push(`必去地点尚未安排：${missing.join("、")}`);
  let estimated = false;
  for (const day of checked) {
    const prefix = `第 ${day.day} 天：`;
    if (!isConcretePlace(day.stay) || day.segments.some((segment) => !isConcretePlace(segment.fromName) || !isConcretePlace(segment.toName))) problems.push(`${prefix}住宿或路线端点不是明确地点`);
    if (day.activities.some((activity) => !isConcretePlace(activity.place.name) || activity.place.locationStatus !== "verified")) problems.push(`${prefix}有地点尚未确认位置`);
    if (day.segments.some((segment) => segment.status === "unavailable")) problems.push(`${prefix}有路段尚未计算完成`);
    if (day.totalDriveS / 3600 > request.maxDriveHours) problems.push(`${prefix}驾驶 ${(day.totalDriveS / 3600).toFixed(1)} 小时，超过 ${request.maxDriveHours} 小时上限`);
    if (!day.activities.length) problems.push(`${prefix}尚未安排游览地点`);
    for (const issue of day.issues.filter((issue) => issue.level === "error" || issue.code === "late_arrival")) problems.push(`${prefix}${issue.message}`);
    if (day.intensity === "not_recommended" && !problems.some((problem) => problem.startsWith(prefix))) problems.push(`${prefix}强度不建议，请调整安排`);
    estimated ||= day.segments.some((segment) => segment.status !== "exact");
  }
  return {
    blocked: problems.length > 0,
    problems: [...new Set(problems)],
    message: problems.length ? `需要调整 · ${[...new Set(problems)].join("；")}` : estimated ? "部分路段仅为估算，请核对导航后再确定行程。" : "已完成车程与强度计算；道路通行、开放时间和预约仍需出发前核对。",
  };
}
