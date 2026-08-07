import { chromium } from "playwright";
import { NextResponse } from "next/server";
import { PlanSchema, TripRequestSchema, type Coordinate } from "@/lib/domain";
import { formatDistance, formatDuration } from "@/lib/utils";

function escapeHtml(value: string) { return value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]!); }

function routeSvg(points: Coordinate[]) {
  if (!points.length) return "";
  const minLat = Math.min(...points.map((p) => p.lat)); const maxLat = Math.max(...points.map((p) => p.lat));
  const minLng = Math.min(...points.map((p) => p.lng)); const maxLng = Math.max(...points.map((p) => p.lng));
  const xy = points.map((p) => ({ x: 40 + ((p.lng - minLng) / (maxLng - minLng || 1)) * 720, y: 300 - ((p.lat - minLat) / (maxLat - minLat || 1)) * 250 }));
  return `<svg viewBox="0 0 800 340" aria-label="全程路线概览"><defs><pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M 32 0 L 0 0 0 32" fill="none" stroke="#d9d3be" stroke-width="1"/></pattern></defs><rect width="800" height="340" rx="18" fill="#f3efdf"/><rect width="800" height="340" rx="18" fill="url(#grid)"/><polyline points="${xy.map((p) => `${p.x},${p.y}`).join(" ")}" fill="none" stroke="#e1583e" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>${xy.map((p, i) => `<circle cx="${p.x}" cy="${p.y}" r="9" fill="#123f36"/><text x="${p.x + 12}" y="${p.y - 10}" font-size="12">${i + 1}</text>`).join("")}<text x="20" y="326" font-size="10" fill="#66736f">路线数据 © OpenStreetMap contributors / OSRM</text></svg>`;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const plan = PlanSchema.parse(body.plan); const trip = TripRequestSchema.parse(body.request);
    const points = plan.days.flatMap((day) => day.activities.map((activity) => activity.place.location));
    const days = plan.days.map((day) => `<section><h2>D${day.day} · ${escapeHtml(day.title)}</h2><div class="meta">${formatDistance(day.totalDistanceM)} · 自驾 ${formatDuration(day.totalDriveS)} · 住 ${escapeHtml(day.stay)}</div>${day.activities.map((item) => `<h3>${escapeHtml(item.startTime)}–${escapeHtml(item.endTime)} ${escapeHtml(item.place.name)}</h3><p>${escapeHtml(item.place.knowledge.summary)}</p><ul>${item.place.knowledge.playTips.map((tip) => `<li>${escapeHtml(tip)}</li>`).join("")}</ul>`).join("")}<p class="stay">住宿建议：${escapeHtml(day.stay)}｜${escapeHtml(day.stayReason)}</p></section>`).join("");
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>@page{size:A4;margin:16mm}body{font-family:"PingFang SC","Noto Sans CJK SC",sans-serif;color:#123f36;font-size:12px;line-height:1.65}h1{font-size:30px;margin:0;color:#e1583e}h2{font-size:18px;border-bottom:2px solid #e1583e;padding-bottom:6px;margin-top:22px}h3{font-size:13px;margin:12px 0 2px}.meta{color:#6c7874;font-weight:600}.stay{background:#f3efdf;padding:8px 12px;border-radius:8px}section{break-inside:avoid}svg{width:100%;margin:16px 0}ul{margin-top:2px}</style></head><body><h1>${escapeHtml(trip.destination)} · ${escapeHtml(plan.name)}</h1><p>${escapeHtml(plan.tagline)}｜${trip.days}天自驾计划</p>${routeSvg(points)}${days}</body></html>`;
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage(); await page.setContent(html, { waitUntil: "load" }); const pdf = await page.pdf({ format: "A4", printBackground: true }); await browser.close();
    return new NextResponse(Buffer.from(pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${trip.destination}-${plan.name}.pdf`)}` } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "PDF 导出失败" }, { status: 500 });
  }
}
