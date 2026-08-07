"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { del, get, set } from "idb-keyval";
import { ArrowDown, ArrowRight, ArrowUp, BedDouble, BookOpenText, CarFront, Check, ChevronRight, CircleAlert, Clock3, Download, ExternalLink, GripVertical, LoaderCircle, Map, MapPinned, Plus, RefreshCw, Route, Share2, Sparkles, Trash2, UsersRound, X } from "lucide-react";
import type { Activity, DayPlan, Place, Plan, TripBundle, TripRequest } from "@/lib/domain";
import { formatDistance, formatDuration, formatHours, id, summarizePlan } from "@/lib/utils";

const TripMap = dynamic(() => import("./trip-map"), { ssr: false, loading: () => <div className="map-loading"><LoaderCircle className="spin" /> 正在展开地图…</div> });
const DRAFT_KEY = "travel-planner:last-draft";

const paceLabels = { relaxed: "轻松", balanced: "适中", compact: "紧凑" } as const;
const intensityLabels = { relaxed: "轻松", balanced: "适中", tiring: "较累", not_recommended: "不建议" } as const;
const interests = ["自然风光", "亲子", "人文历史", "美食", "摄影", "轻徒步"];

const initialRequest: TripRequest = {
  destination: "", days: 5, adults: 2, children: 0, childAges: [], seniors: 0, pace: "balanced", interests: ["自然风光"], mustGo: [], avoid: [],
  earliestDeparture: "09:00", latestArrival: "19:30", maxDriveHours: 5, notes: "",
};

function LoadingJourney({ text }: { text: string }) {
  return <div className="journey-loader"><div className="loader-road"><span /><CarFront /></div><h3>正在把想法铺成公路</h3><p>{text}</p></div>;
}

function CreateForm({ onGenerated }: { onGenerated: (bundle: TripBundle) => void }) {
  const [form, setForm] = useState(initialRequest);
  const [mustGo, setMustGo] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [loadingText, setLoadingText] = useState("理解你的旅行偏好");

  const update = <K extends keyof TripRequest>(key: K, value: TripRequest[K]) => setForm((current) => ({ ...current, [key]: value }));
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError("");
    const payload = { ...form, mustGo: mustGo.split(/[，,、\n]/).map((value) => value.trim()).filter(Boolean) };
    try {
      const intakeResponse = await fetch("/api/planning/intake", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const intake = await intakeResponse.json();
      if (!intakeResponse.ok) throw new Error(intake.error || "请检查输入");
      if (intake.status === "needs_input") { setError(intake.questions[0]?.question || "还需要补充一项信息"); return; }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "请检查输入"); return; }
    setLoading(true);
    const texts = ["理解你的旅行偏好", "寻找值得停留的地方", "核对地点与路线", "计算每天的驾驶强度", "整理两套可比较方案"];
    let cursor = 0; const timer = window.setInterval(() => setLoadingText(texts[Math.min(++cursor, texts.length - 1)]), 3600);
    try {
      const response = await fetch("/api/planning/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "生成失败"); onGenerated(data);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "生成失败"); }
    finally { clearInterval(timer); setLoading(false); }
  }

  return <main className="create-shell">
    <header className="brand-header"><div className="brand-mark"><Route /></div><div><span>ROADBOOK / 01</span><strong>去野</strong></div><Link href="/admin">运营台</Link></header>
    <section className="hero-copy"><div className="eyebrow"><span />智能自驾旅行规划</div><h1>把想去的地方，<br /><em>排成真正走得通的旅程。</em></h1><p>路线、车程、玩法和住宿，一张地图里安排明白。</p></section>
    <form className="planning-form" onSubmit={submit}>
      <div className="form-lead"><span>01</span><div><h2>从哪里出发去玩？</h2><p>这里只规划目的地内的自驾行程，不含飞机和火车。</p></div></div>
      <div className="form-grid primary-grid">
        <label className="field destination-field"><span>目的地</span><input required value={form.destination} onChange={(e) => update("destination", e.target.value)} placeholder="例如：新疆伊犁、川西、杭州周边" /></label>
        <label className="field"><span>游玩天数</span><div className="stepper"><button type="button" onClick={() => update("days", Math.max(1, form.days - 1))}>−</button><strong>{form.days} 天</strong><button type="button" onClick={() => update("days", Math.min(30, form.days + 1))}>＋</button></div></label>
      </div>
      <div className="form-grid people-grid">
        <label className="field"><span><UsersRound size={15} />成人</span><input type="number" min="1" value={form.adults} onChange={(e) => update("adults", Number(e.target.value))} /></label>
        <label className="field"><span>儿童</span><input type="number" min="0" value={form.children} onChange={(e) => update("children", Number(e.target.value))} /></label>
        <label className="field"><span>老人</span><input type="number" min="0" value={form.seniors} onChange={(e) => update("seniors", Number(e.target.value))} /></label>
      </div>
      {form.children > 0 && <label className="field child-ages"><span>儿童年龄（用于调整休息和驾驶强度）</span><input value={form.childAges.join("、")} onChange={(e) => update("childAges", e.target.value.split(/[，,、\s]+/).map(Number).filter((age) => Number.isFinite(age) && age >= 0 && age < 18))} placeholder="例如：8、10" /></label>}
      <div className="form-grid">
        <fieldset className="field"><legend>旅行节奏</legend><div className="segmented">{Object.entries(paceLabels).map(([value, label]) => <button type="button" className={form.pace === value ? "active" : ""} onClick={() => update("pace", value as TripRequest["pace"])} key={value}>{label}</button>)}</div></fieldset>
        <label className="field"><span>单日最长驾驶</span><input type="range" min="2" max="10" step="0.5" value={form.maxDriveHours} onChange={(e) => update("maxDriveHours", Number(e.target.value))} /><b>{form.maxDriveHours}h</b></label>
      </div>
      <fieldset className="field"><legend>偏好体验</legend><div className="interest-list">{interests.map((item) => <button type="button" key={item} className={form.interests.includes(item) ? "active" : ""} onClick={() => update("interests", form.interests.includes(item) ? form.interests.filter((value) => value !== item) : [...form.interests, item])}>{form.interests.includes(item) && <Check size={14} />}{item}</button>)}</div></fieldset>
      <div className="form-grid">
        <label className="field"><span>每天出发 / 返回</span><div className="time-row"><input type="time" value={form.earliestDeparture} onChange={(e) => update("earliestDeparture", e.target.value)} /><ArrowRight /><input type="time" value={form.latestArrival} onChange={(e) => update("latestArrival", e.target.value)} /></div></label>
        <label className="field"><span>一定想去</span><input value={mustGo} onChange={(e) => setMustGo(e.target.value)} placeholder="多个景点用逗号分隔，可留空" /></label>
      </div>
      {error && <div className="form-error"><CircleAlert />{error}</div>}
      <button className="generate-button" disabled={loading}>{loading ? <><LoaderCircle className="spin" />正在规划</> : <><Sparkles />生成两套旅行方案<ChevronRight /></>}</button>
      <p className="form-footnote">景点资料由 Tavily 自动检索；距离和车程来自 OSM / OSRM，并标记估算项。</p>
    </form>
    {loading && <LoadingJourney text={loadingText} />}
  </main>;
}

function downloadBlob(blob: Blob, filename: string) { const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url); }

export default function PlannerApp({ initialBundle, readOnly = false }: { initialBundle?: TripBundle; readOnly?: boolean }) {
  const [bundle, setBundle] = useState<TripBundle | null>(initialBundle ?? null);
  const [selectedDayId, setSelectedDayId] = useState<string>();
  const [selectedPlaceId, setSelectedPlaceId] = useState<string>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [working, setWorking] = useState("");
  const [notice, setNotice] = useState("");
  const [newPlace, setNewPlace] = useState("");

  useEffect(() => { if (!initialBundle && !readOnly) get<TripBundle>(DRAFT_KEY).then((draft) => draft && setBundle(draft)); }, [initialBundle, readOnly]);
  useEffect(() => { if (bundle && !readOnly) set(DRAFT_KEY, bundle); }, [bundle, readOnly]);
  const plan = useMemo(() => bundle?.plans.find((item) => item.id === bundle.selectedPlanId) ?? bundle?.plans[0], [bundle]);
  const selectedDay = plan?.days.find((day) => day.id === selectedDayId) ?? plan?.days[0];
  const selectedActivity = selectedDay?.activities.find((activity) => activity.place.id === selectedPlaceId);
  const stats = plan ? summarizePlan(plan) : null;

  if (!bundle || !plan || !stats) return <CreateForm onGenerated={(value) => { setBundle(value); setSelectedDayId(value.plans[0].days[0]?.id); }} />;

  function updatePlan(nextPlan: Plan) { setBundle((current) => current ? { ...current, plans: current.plans.map((item) => item.id === nextPlan.id ? nextPlan : item), updatedAt: new Date().toISOString() } : current); }
  function updateDay(nextDay: DayPlan) { updatePlan({ ...plan!, days: plan!.days.map((day) => day.id === nextDay.id ? nextDay : day) }); }
  function selectDay(day: DayPlan) { setSelectedDayId(day.id); setSelectedPlaceId(undefined); setDrawerOpen(true); }
  function selectPlace(place: Place, dayId: string) { setSelectedDayId(dayId); setSelectedPlaceId(place.id); setDrawerOpen(true); }
  function moveActivity(activityId: string, delta: number) {
    if (!selectedDay) return; const index = selectedDay.activities.findIndex((item) => item.id === activityId); const target = index + delta;
    if (index < 0 || target < 0 || target >= selectedDay.activities.length) return; const activities = [...selectedDay.activities]; [activities[index], activities[target]] = [activities[target], activities[index]]; updateDay({ ...selectedDay, activities });
  }
  async function recalculate() {
    if (!bundle || !plan) return; setWorking("正在重新计算路线");
    try { const response = await fetch("/api/planning/recalculate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request: bundle.request, plan }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); updatePlan(data); setNotice(`已生成方案版本 v${data.version}`); }
    catch (error) { setNotice(error instanceof Error ? error.message : "重算失败"); } finally { setWorking(""); }
  }
  async function addPlace() {
    if (!bundle || !selectedDay || !newPlace.trim()) return; setWorking("正在搜索景点资料");
    try { const response = await fetch("/api/places/enrich", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: newPlace, destination: bundle.request.destination }) }); const place = await response.json(); if (!response.ok) throw new Error(place.error); const activity: Activity = { id: id("activity"), type: "place", place, startTime: "", endTime: "", durationMin: place.knowledge.suggestedDurationMin, note: place.knowledge.playTips[0] || "" }; updateDay({ ...selectedDay, activities: [...selectedDay.activities, activity] }); setSelectedPlaceId(place.id); setNewPlace(""); setNotice("景点已加入，请重新计算路线"); }
    catch (error) { setNotice(error instanceof Error ? error.message : "添加失败"); } finally { setWorking(""); }
  }
  async function share() {
    setWorking("正在创建只读快照"); try { const response = await fetch("/api/shares", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bundle) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); await navigator.clipboard.writeText(`${location.origin}${data.url}`); setNotice("只读分享链接已复制"); } catch (error) { setNotice(error instanceof Error ? error.message : "分享失败"); } finally { setWorking(""); }
  }
  async function exportFile(format: "xlsx" | "pdf") {
    if (!bundle || !plan) return;
    setWorking(`正在生成 ${format.toUpperCase()}`); try { const response = await fetch(`/api/exports/${format}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request: bundle.request, plan }) }); if (!response.ok) { const data = await response.json(); throw new Error(data.error); } downloadBlob(await response.blob(), `${bundle.request.destination}-${plan.name}.${format}`); } catch (error) { setNotice(error instanceof Error ? error.message : "导出失败"); } finally { setWorking(""); }
  }

  return <main className="planner-shell">
    <aside className="itinerary-panel">
      <header className="planner-brand"><button aria-label="返回创建" onClick={() => { if (!readOnly) { setBundle(null); del(DRAFT_KEY); } }}><Route /></button><div><small>{readOnly ? "SHARED ROADBOOK" : "YOUR ROADBOOK"}</small><strong>{bundle.request.destination}</strong></div><span className={`source-mode ${bundle.sourceMode}`}>{bundle.sourceMode === "live" ? "实时资料" : bundle.sourceMode === "mixed" ? "混合资料" : "演示降级"}</span></header>
      <section className="trip-summary"><div><span>{bundle.request.days}</span>天</div><div><span>{formatDistance(stats.distanceM)}</span>总里程</div><div><span>{formatHours(stats.driveS)}</span>自驾</div></section>
      <div className="plan-tabs">{bundle.plans.map((item, index) => <button key={item.id} className={plan.id === item.id ? "active" : ""} onClick={() => setBundle({ ...bundle, selectedPlanId: item.id })}><small>方案 {String.fromCharCode(65 + index)}</small><strong>{item.name}</strong><span>{item.tagline}</span></button>)}</div>
      <div className="day-list">{plan.days.map((day) => <button key={day.id} className={`day-card ${day.id === selectedDay?.id ? "active" : ""}`} onClick={() => selectDay(day)}>
        <span className={`day-number ${plan.accent}`}><small>DAY</small>{day.day}</span><div className="day-copy"><strong>{day.title}</strong><span>{day.activities.map((item) => item.place.name).join(" → ")}</span><small><BedDouble />{day.stay}</small></div><div className="day-metrics"><b>{formatDistance(day.totalDistanceM)}</b><span><CarFront />{formatHours(day.totalDriveS)}</span><em className={day.intensity}>{intensityLabels[day.intensity]}</em></div>
      </button>)}</div>
      <footer className="panel-actions">{!readOnly && <button onClick={recalculate}><RefreshCw />重算</button>}<button onClick={share}><Share2 />分享</button><button onClick={() => exportFile("xlsx")}><Download />Excel</button><button onClick={() => exportFile("pdf")}><Download />PDF</button></footer>
    </aside>
    <section className="map-stage"><TripMap plan={plan} selectedDayId={selectedDayId} onSelectPlace={selectPlace} /><div className="map-title"><small>{selectedDayId ? `DAY ${selectedDay?.day}` : "ALL ROUTES"}</small><strong>{selectedDayId ? selectedDay?.title : plan.name}</strong><button onClick={() => setSelectedDayId(undefined)}><Map />全程</button></div><div className="map-legend"><span className={plan.accent} />精确路线 <i />估算路段</div></section>
    <section className={`detail-drawer ${drawerOpen ? "open" : ""}`}>
      <button className="drawer-close" onClick={() => setDrawerOpen(false)}><X /></button>
      {selectedDay && <><header className="drawer-header"><div><small>DAY {selectedDay.day} / DETAIL</small><h2>{selectedDay.title}</h2><p><Route />{formatDistance(selectedDay.totalDistanceM)} · <Clock3 />{formatDuration(selectedDay.totalDriveS)} · <BedDouble />住 {selectedDay.stay}</p></div><em className={selectedDay.intensity}>{intensityLabels[selectedDay.intensity]}</em></header>
      {selectedActivity ? <PlaceDetail activity={selectedActivity} onBack={() => setSelectedPlaceId(undefined)} /> : <>
        <div className="section-heading"><span>当天时间轴</span><small>可调整顺序后重新计算</small></div>
        <div className="timeline">{selectedDay.activities.map((activity, index) => <div className="timeline-item" key={activity.id} draggable={!readOnly} onDragStart={(event) => event.dataTransfer.setData("activity", activity.id)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { const source = event.dataTransfer.getData("activity"); const from = selectedDay.activities.findIndex((item) => item.id === source); if (from >= 0) moveActivity(source, index - from); }}>
          <time>{activity.startTime || "待算"}</time><span className="timeline-dot" /><div><button className="place-title" onClick={() => setSelectedPlaceId(activity.place.id)}>{activity.place.name}<ChevronRight /></button><p>{activity.place.knowledge.highlights.slice(0, 2).join(" · ") || activity.place.knowledge.summary}</p><small>{formatDuration(activity.durationMin * 60)} · {activity.place.knowledge.status === "confirmed" ? "运营确认" : activity.place.knowledge.status === "auto" ? "自动整理" : "待确认"}</small></div>{!readOnly && <div className="reorder-actions"><GripVertical /><button onClick={() => moveActivity(activity.id, -1)}><ArrowUp /></button><button onClick={() => moveActivity(activity.id, 1)}><ArrowDown /></button><button onClick={() => updateDay({ ...selectedDay, activities: selectedDay.activities.filter((item) => item.id !== activity.id) })}><Trash2 /></button></div>}
          {selectedDay.segments[index] && <div className="segment-row"><CarFront />前往 {selectedDay.segments[index].toName}<b>{formatDistance(selectedDay.segments[index].distanceM)} · {formatDuration(selectedDay.segments[index].durationS)}</b>{selectedDay.segments[index].status !== "exact" && <em>估算</em>}{selectedDay.segments[index].navigationUrl && <a href={selectedDay.segments[index].navigationUrl} target="_blank"><ExternalLink />导航</a>}</div>}
        </div>)}</div>
        {!readOnly && <div className="add-place"><input value={newPlace} onChange={(e) => setNewPlace(e.target.value)} placeholder="增加一个景点，例如：夏塔旅游区" /><button onClick={addPlace}><Plus />搜索并加入</button></div>}
        <div className="stay-card"><BedDouble /><div><small>当晚住宿区域</small><input readOnly={readOnly} value={selectedDay.stay} onChange={(e) => updateDay({ ...selectedDay, stay: e.target.value })} /><p>{selectedDay.stayReason}</p></div></div>
        {selectedDay.issues.length > 0 && <div className="issues">{selectedDay.issues.map((issue) => <p key={issue.id} className={issue.level}><CircleAlert />{issue.message}</p>)}</div>}
      </>}</>}
    </section>
    {(working || notice) && <div className={`toast ${working ? "working" : ""}`}>{working ? <LoaderCircle className="spin" /> : <Check />}{working || notice}<button onClick={() => setNotice("")}><X /></button></div>}
  </main>;
}

function PlaceDetail({ activity, onBack }: { activity: Activity; onBack: () => void }) {
  const place = activity.place; const knowledge = place.knowledge;
  return <div className="place-detail"><button className="back-link" onClick={onBack}>← 返回当天安排</button><div className="place-kicker"><MapPinned />{place.category}<span>{knowledge.status === "confirmed" ? "已确认" : knowledge.status === "auto" ? "自动整理" : "待确认"}</span></div><h3>{place.name}</h3><p className="place-summary">{knowledge.summary}</p>
    <div className="detail-grid"><section><h4><Sparkles />这里有什么</h4><ul>{knowledge.highlights.map((item) => <li key={item}>{item}</li>)}</ul></section><section><h4><BookOpenText />怎么玩</h4><ol>{knowledge.playTips.map((item) => <li key={item}>{item}</li>)}</ol></section></div>
    <div className="fact-row"><span><Clock3 />建议 {formatDuration(knowledge.suggestedDurationMin * 60)}</span><span><UsersRound />{knowledge.suitableFor.join("、") || "家庭游客"}</span></div>
    {(knowledge.openingHours || knowledge.reservation) && <div className="official-info"><strong>到访信息</strong>{knowledge.openingHours && <p>开放时间：{knowledge.openingHours}</p>}{knowledge.reservation && <p>预约：{knowledge.reservation}</p>}</div>}
    {knowledge.cautions.length > 0 && <div className="cautions"><strong>出发前留意</strong>{knowledge.cautions.map((item) => <p key={item}>{item}</p>)}</div>}
    <section className="sources"><h4>资料来源 <small>更新于 {new Date(knowledge.updatedAt).toLocaleDateString("zh-CN")}</small></h4>{knowledge.sources.length ? knowledge.sources.map((source) => <a href={source.url} target="_blank" key={source.id}><span>{source.official ? "官方" : "来源"}</span><div><strong>{source.title}</strong><small>{source.siteName}</small></div><ExternalLink /></a>) : <p>暂未获得可引用的网络来源，信息已标记待确认。</p>}</section>
  </div>;
}
