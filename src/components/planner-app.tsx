"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { del, get, set } from "idb-keyval";
import { ArrowDown, ArrowRight, ArrowUp, BedDouble, BookOpenText, Bot, CalendarDays, CarFront, Check, ChevronRight, CircleAlert, Clock3, Download, ExternalLink, GripVertical, History, LoaderCircle, Map, MapPinned, MessageCircle, Plus, RefreshCw, Route, Send, Share2, Sparkles, Trash2, UsersRound, X } from "lucide-react";
import type { Activity, AgentEvent, AgentSession, DayPlan, Place, Plan, TripBundle, TripSummary } from "@/lib/domain";
import { formatDistance, formatDuration, formatHours, id, summarizePlan } from "@/lib/utils";

const TripMap = dynamic(() => import("./trip-map"), { ssr: false, loading: () => <div className="map-loading"><LoaderCircle className="spin" /> 正在展开地图…</div> });
const DRAFT_KEY = "travel-planner:last-draft";
const SESSION_KEY = "travel-planner:agent-session";

const intensityLabels = { relaxed: "轻松", balanced: "适中", tiring: "较累", not_recommended: "不建议" } as const;
const paceLabels = { relaxed: "轻松", balanced: "适中", compact: "紧凑" } as const;

type TurnInput =
  | { type: "message"; message: string }
  | { type: "generate" }
  | { type: "select_plan"; planId: string }
  | { type: "confirm_change" }
  | { type: "cancel_change" }
  | { type: "restore_revision"; revisionId: string };

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function readEvents(response: Response, onEvent: (event: AgentEvent) => void) {
  if (!response.body) throw new Error("Agent 没有返回内容");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) onEvent(JSON.parse(line) as AgentEvent);
    if (done) break;
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer) as AgentEvent);
}

function AgentPanel({ session, bundle, working, onTurn, onNewTrip, onTripsOpen, mobileActive, hideHeader }: {
  session: AgentSession | null;
  bundle: TripBundle | null;
  working: string;
  onTurn: (input: TurnInput) => Promise<void>;
  onNewTrip: () => void;
  onTripsOpen: () => void;
  mobileActive: boolean;
  hideHeader?: boolean;
}) {
  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }); }, [session?.messages.length, working]);
  const selectedPlan = bundle?.plans.find((item) => item.id === bundle.selectedPlanId);
  const revisions = bundle?.revisions.filter((revision) => revision.planId === selectedPlan?.id).slice(-4).reverse() ?? [];

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = input.trim();
    if (!value || working) return;
    setInput("");
    await onTurn({ type: "message", message: value });
  };

  const handleReply = (reply: string) => {
    if (reply === "开始规划") return onTurn({ type: "generate" });
    if (reply === "确认修改") return onTurn({ type: "confirm_change" });
    if (reply === "取消") return onTurn({ type: "cancel_change" });
    setInput(reply);
  };

  return <section className={`agent-panel ${mobileActive ? "mobile-active" : ""}`} aria-label="旅行 Agent 对话">
    {!hideHeader && <header className="agent-header">
      <button className="agent-mark" onClick={onNewTrip} aria-label="开始新行程"><Route /></button>
      <div><small>TRAVEL AGENT</small><strong>去野 · 旅伴</strong></div>
      <button className="my-trips-button" onClick={onTripsOpen} aria-label="我的行程"><BookOpenText /><span>我的行程</span></button>
    </header>}
    <div className="agent-messages" ref={listRef}>
      {!session && <div className="agent-boot"><LoaderCircle className="spin" /><span>正在唤醒旅行 Agent</span></div>}
      {session?.messages.filter((item) => item.kind !== "system").map((item) => <article key={item.id} className={`agent-message ${item.role} ${item.kind}`}>
        {item.role === "assistant" && <span className="message-avatar"><Bot /></span>}
        <div className="message-bubble"><p>{item.content}</p>{item.quickReplies.length > 0 && <div className="quick-replies">{item.quickReplies.map((reply) => <button key={reply} disabled={Boolean(working)} onClick={() => handleReply(reply)}>{reply}<ChevronRight /></button>)}</div>}</div>
      </article>)}
      {session?.pendingChange && <section className="change-preview-card">
        <small>待确认修改</small><strong>{session.pendingChange.summary}</strong>
        <div><span>影响第 {session.pendingChange.affectedDays.join("、")} 天</span><span>{formatDistance(session.pendingChange.before.distanceM)} → {formatDistance(session.pendingChange.after.distanceM)}</span></div>
        <footer><button onClick={() => onTurn({ type: "cancel_change" })}>保留原方案</button><button onClick={() => onTurn({ type: "confirm_change" })}><Check />确认修改</button></footer>
      </section>}
      {working && <article className="agent-message assistant status"><span className="message-avatar"><Bot /></span><div className="message-bubble working"><LoaderCircle className="spin" /><p>{working}</p></div></article>}
      {revisions.length > 1 && <details className="version-history"><summary><History />方案版本</summary>{revisions.map((revision, index) => <button key={revision.id} disabled={index === 0 || Boolean(working)} onClick={() => onTurn({ type: "restore_revision", revisionId: revision.id })}><span>v{revision.version} · {revision.summary}</span><small>{index === 0 ? "当前" : "恢复"}</small></button>)}</details>}
    </div>
    <form className="agent-composer" onSubmit={submit}>
      <textarea aria-label="给旅行 Agent 发消息" rows={2} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={bundle ? "例如：第二天轻松一点…" : "说说你想去哪里、玩几天…"} />
      <button aria-label="发送" disabled={!input.trim() || Boolean(working)}><Send /></button>
    </form>
    <p className="agent-disclaimer">路线与车程由地图服务计算；估算项会明确标记。</p>
  </section>;
}

function MyTripsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [trips, setTrips] = useState<TripSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError("");
    fetch("/api/trips")
      .then((res) => res.json())
      .then((data: { trips: TripSummary[]; error?: string }) => {
        if (data.error) throw new Error(data.error);
        setTrips(data.trips);
      })
      .catch((err: Error) => setError(err.message || "加载失败"))
      .finally(() => setLoading(false));
  }, [open]);

  function formatDate(value: string) {
    return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  }

  return <>
    {open && <div className="my-trips-backdrop" onClick={onClose} />}
    <aside className={`my-trips-panel ${open ? "open" : ""}`} aria-label="我的行程">
      <header className="my-trips-header">
        <div><small>MY TRIPS</small><strong>我的行程</strong></div>
        <button onClick={onClose} aria-label="关闭"><X /></button>
      </header>
      <div className="my-trips-body">
        {loading && <div className="my-trips-loading"><LoaderCircle className="spin" /><span>加载中…</span></div>}
        {error && <div className="my-trips-error"><CircleAlert />{error}</div>}
        {!loading && !error && trips.length === 0 && (
          <div className="my-trips-empty"><BookOpenText /><p>还没有保存的行程</p><small>生成并完成规划后自动出现在这里</small></div>
        )}
        {!loading && trips.map((trip) => (
          <Link key={trip.id} className="my-trips-card" href={`/trips/${trip.id}`} onClick={onClose}>
            <div className="my-trips-card-main">
              <div className="my-trips-destination"><MapPinned />{trip.destination}</div>
              <strong>{trip.selectedPlanName}</strong>
              <time>{formatDate(trip.updatedAt)}</time>
            </div>
            <div className="my-trips-card-meta">
              <span>{trip.days} 天</span>
              <ChevronRight />
            </div>
          </Link>
        ))}
      </div>
      {trips.length > 0 && (
        <footer className="my-trips-footer">
          <Link href="/trips" onClick={onClose}>查看全部 {trips.length} 份行程 <ArrowRight /></Link>
        </footer>
      )}
    </aside>
  </>;
}

function BriefCanvas({ session, working, onGenerate, mobileActive, inline }: { session: AgentSession | null; working: string; onGenerate: () => void; mobileActive: boolean; inline?: boolean }) {
  const brief = session?.brief;
  const ready = session?.stage === "ready";
  if (inline) return <div className="brief-inline">
    <div className="brief-title"><Sparkles /><div><small>当前旅行需求</small><strong>{brief?.destination || "等待目的地"}</strong></div><span className={ready ? "ready" : "collecting"}>{ready ? "可以规划" : "沟通中"}</span></div>
    <div className="brief-grid">
      <div><small>游玩天数</small><strong>{brief?.days ? `${brief.days} 天` : "待补充"}</strong></div>
      <div><small>同行人员</small><strong>{brief ? `${brief.adults ?? 2} 成人${brief.children ? ` · ${brief.children} 儿童` : ""}${brief.seniors ? ` · ${brief.seniors} 老人` : ""}` : "待沟通"}</strong></div>
      <div><small>旅行节奏</small><strong>{brief?.pace ? paceLabels[brief.pace] : "适中"}</strong></div>
      <div><small>驾驶上限</small><strong>{brief?.maxDriveHours ?? 5} 小时/天</strong></div>
    </div>
    <div className="brief-tags"><small>偏好与必去</small>{brief?.interests?.length || brief?.mustGo?.length ? <div>{[...(brief.interests ?? []), ...(brief.mustGo ?? []).map((item) => `必去 · ${item}`)].map((item) => <span key={item}>{item}</span>)}</div> : <p>在对话中告诉我喜欢自然、人文、美食、摄影或亲子体验。</p>}</div>
    <button className="brief-generate" disabled={!ready || Boolean(working)} onClick={onGenerate}>{working ? <LoaderCircle className="spin" /> : <Sparkles />}{working || (ready ? "生成两套自驾方案" : "继续对话补齐关键信息")}<ArrowRight /></button>
  </div>;
  return <section className={`brief-canvas ${mobileActive ? "mobile-active" : ""}`}>
    <div className="brief-map-pattern" />
    <header><span>01</span><div><small>TRIP BRIEF</small><h1>把聊天，变成一条<br /><em>真正走得通的路</em></h1><p>不用填一整页表单。边聊边补充，我会把每个决定同步整理在这里。</p></div></header>
    <div className="brief-card">
      <div className="brief-title"><Sparkles /><div><small>当前旅行需求</small><strong>{brief?.destination || "等待目的地"}</strong></div><span className={ready ? "ready" : "collecting"}>{ready ? "可以规划" : "沟通中"}</span></div>
      <div className="brief-grid">
        <div><small>游玩天数</small><strong>{brief?.days ? `${brief.days} 天` : "待补充"}</strong></div>
        <div><small>同行人员</small><strong>{brief ? `${brief.adults ?? 2} 成人${brief.children ? ` · ${brief.children} 儿童` : ""}${brief.seniors ? ` · ${brief.seniors} 老人` : ""}` : "待沟通"}</strong></div>
        <div><small>旅行节奏</small><strong>{brief?.pace ? paceLabels[brief.pace] : "适中"}</strong></div>
        <div><small>驾驶上限</small><strong>{brief?.maxDriveHours ?? 5} 小时/天</strong></div>
      </div>
      <div className="brief-tags"><small>偏好与必去</small>{brief?.interests?.length || brief?.mustGo?.length ? <div>{[...(brief.interests ?? []), ...(brief.mustGo ?? []).map((item) => `必去 · ${item}`)].map((item) => <span key={item}>{item}</span>)}</div> : <p>在对话中告诉我喜欢自然、人文、美食、摄影或亲子体验。</p>}</div>
      <button className="brief-generate" disabled={!ready || Boolean(working)} onClick={onGenerate}>{working ? <LoaderCircle className="spin" /> : <Sparkles />}{working || (ready ? "生成两套自驾方案" : "继续对话补齐关键信息")}<ArrowRight /></button>
    </div>
    <footer><span>渐进提问</span><span>路线校验</span><span>修改前确认</span><span>匿名保存</span></footer>
  </section>;
}

export default function PlannerApp({ initialBundle, readOnly = false }: { initialBundle?: TripBundle; readOnly?: boolean }) {
  const router = useRouter();
  const [bundle, setBundle] = useState<TripBundle | null>(initialBundle ?? null);
  const [session, setSession] = useState<AgentSession | null>(null);
  const [selectedDayId, setSelectedDayId] = useState<string>();
  const [selectedPlaceId, setSelectedPlaceId] = useState<string>();
  const [drawerOpen, setDrawerOpen] = useState(Boolean(initialBundle));
  const [working, setWorking] = useState("");
  const [notice, setNotice] = useState("");
  const [newPlace, setNewPlace] = useState("");
  const [saveState, setSaveState] = useState<"saving" | "saved" | "error">("saved");
  const [manualDirty, setManualDirty] = useState(false);
  const [mobileView, setMobileView] = useState<"chat" | "itinerary" | "map">("chat");
  const [tripsOpen, setTripsOpen] = useState(false);
  const latestBundle = useRef<TripBundle | null>(bundle);
  const latestManualDirty = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);
  const bootstrapped = useRef(false);

  useEffect(() => {
    if (readOnly || bootstrapped.current) return;
    bootstrapped.current = true;
    (async () => {
      const localDraft = initialBundle ? null : await get<TripBundle>(DRAFT_KEY);
      const savedSessionId = initialBundle?.agentSessionId ?? await get<string>(SESSION_KEY);
      if (savedSessionId) {
        const response = await fetch(`/api/agent/sessions/${savedSessionId}`);
        if (response.ok) {
          const data = await response.json() as { session: AgentSession; trip?: TripBundle };
          setSession(data.session);
          if (data.trip) {
            const newerDraft = localDraft?.schemaVersion === 2 && localDraft.id === data.trip.id && localDraft.updatedAt > data.trip.updatedAt ? localDraft : null;
            const restoredBundle = newerDraft ?? data.trip;
            setBundle(restoredBundle);
            setSelectedDayId(restoredBundle.plans.find((item) => item.id === restoredBundle.selectedPlanId)?.days[0]?.id);
            setDrawerOpen(true);
            setManualDirty(Boolean(newerDraft));
          }
          await set(SESSION_KEY, data.session.id);
          return;
        }
      }
      const tripId = initialBundle?.id ?? localDraft?.id;
      const response = await fetch("/api/agent/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tripId }) });
      if (!response.ok) throw new Error("无法创建对话");
      const created = await response.json() as AgentSession;
      setSession(created);
      await set(SESSION_KEY, created.id);
      if (tripId) {
        const restored = await fetch(`/api/agent/sessions/${created.id}`).then((item) => item.json()) as { trip?: TripBundle };
        if (restored.trip) {
          const newerDraft = localDraft?.schemaVersion === 2 && localDraft.id === restored.trip.id && localDraft.updatedAt > restored.trip.updatedAt ? localDraft : null;
          const restoredBundle = newerDraft ?? restored.trip;
          setBundle(restoredBundle);
          setSelectedDayId(restoredBundle.plans.find((item) => item.id === restoredBundle.selectedPlanId)?.days[0]?.id);
          setDrawerOpen(true);
          setManualDirty(Boolean(newerDraft));
        }
      }
    })().catch((error) => setNotice(error instanceof Error ? error.message : "Agent 初始化失败"));
  }, [initialBundle, readOnly]);

  useEffect(() => {
    latestBundle.current = bundle;
    latestManualDirty.current = manualDirty;
    if (!bundle || readOnly) return;
    set(DRAFT_KEY, bundle);
    if (manualDirty) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      setSaveState("saving");
      try {
        const response = await fetch(`/api/trips/${bundle.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bundle) });
        if (!response.ok) throw new Error("自动保存失败");
        setSaveState("saved");
      } catch {
        setSaveState("error");
        setNotice("自动保存失败，请稍后重试");
      }
    }, 500);
  }, [bundle, manualDirty, readOnly]);

  useEffect(() => () => {
    window.clearTimeout(saveTimer.current);
    const current = latestBundle.current;
    if (current && !readOnly && !latestManualDirty.current) fetch(`/api/trips/${current.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(current), keepalive: true }).catch(() => undefined);
  }, [readOnly]);

  const plan = useMemo(() => bundle?.plans.find((item) => item.id === bundle.selectedPlanId) ?? bundle?.plans[0], [bundle]);
  const selectedDay = plan?.days.find((day) => day.id === selectedDayId) ?? plan?.days[0];
  const selectedActivity = selectedDay?.activities.find((activity) => activity.place.id === selectedPlaceId);
  const stats = plan ? summarizePlan(plan) : null;

  async function turn(input: TurnInput) {
    if (!session || working) return;
    setNotice("");
    setWorking(input.type === "generate" ? "正在生成两套路线" : "Agent 正在思考");
    try {
      const response = await fetch(`/api/agent/sessions/${session.id}/turns`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      await readEvents(response, (event) => {
        if (event.type === "progress" || event.type === "ack") setWorking(event.message);
        if (event.type === "session") setSession(event.session);
        if (event.type === "trip") {
          setManualDirty(false);
          setBundle(event.trip);
          setSelectedDayId(event.trip.plans.find((item) => item.id === event.trip.selectedPlanId)?.days[0]?.id);
          setDrawerOpen(true);
          setMobileView("itinerary");
        }
        if (event.type === "error") throw new Error(event.message);
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Agent 暂时无法处理，请重试");
    } finally { setWorking(""); }
  }

  async function newTrip() {
    await del(DRAFT_KEY);
    await del(SESSION_KEY);
    if (location.pathname !== "/") { router.push("/"); return; }
    setBundle(null); setSession(null); setManualDirty(false); setSelectedDayId(undefined); setDrawerOpen(false); setMobileView("chat");
    const response = await fetch("/api/agent/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (response.ok) { const created = await response.json() as AgentSession; setSession(created); await set(SESSION_KEY, created.id); }
  }

  if (!bundle || !plan || !stats) return <main className="home-shell">
    <header className="home-nav">
      <button className="home-nav-brand" onClick={newTrip} aria-label="回到首页">
        <span className="home-nav-mark"><Route /></span>
        <span className="home-nav-title"><strong>去野</strong><small>自驾规划</small></span>
      </button>
      <nav className="home-nav-links" aria-label="主导航">
        <Link className="home-nav-link" href="/trips"><BookOpenText />我的行程</Link>
        <Link className="home-nav-link" href="/about">关于</Link>
      </nav>
    </header>

    <div className="home-body">
      <div className="home-chat-area">
        <div className="home-hero">
          <h1>把想去的地方<br /><em>排成走得通的路</em></h1>
          <p>告诉我目的地和行程天数，我来帮你规划一条真实可行的自驾路线。</p>
        </div>
        <AgentPanel session={session} bundle={null} working={working} onTurn={turn} onNewTrip={newTrip} onTripsOpen={() => setTripsOpen(true)} mobileActive={true} hideHeader />
        <BriefCanvas session={session} working={working} onGenerate={() => turn({ type: "generate" })} mobileActive={false} inline />
      </div>
    </div>

    <footer className="home-footer">
      <div className="home-footer-features">
        <span><Sparkles />渐进提问</span>
        <span><Route />路线校验</span>
        <span><Check />修改前确认</span>
        <span><MessageCircle />匿名保存</span>
      </div>
      <p className="home-footer-copy">路线与车程由地图服务计算；估算项会明确标记。</p>
    </footer>

    <MyTripsPanel open={tripsOpen} onClose={() => setTripsOpen(false)} />
    {notice && <div className="toast" role="alert"><CircleAlert />{notice}<button onClick={() => setNotice("")}><X /></button></div>}
  </main>;

  function updatePlan(nextPlan: Plan) { setManualDirty(true); setBundle((current) => current ? { ...current, plans: current.plans.map((item) => item.id === nextPlan.id ? nextPlan : item), updatedAt: new Date().toISOString() } : current); }
  function updateDay(nextDay: DayPlan) { updatePlan({ ...plan!, days: plan!.days.map((day) => day.id === nextDay.id ? nextDay : day) }); }
  function selectDay(day: DayPlan) { setSelectedDayId(day.id); setSelectedPlaceId(undefined); setDrawerOpen(true); }
  function selectPlace(place: Place, dayId: string) { setSelectedDayId(dayId); setSelectedPlaceId(place.id); setDrawerOpen(true); }
  function moveActivity(activityId: string, delta: number) {
    if (!selectedDay) return;
    const index = selectedDay.activities.findIndex((item) => item.id === activityId); const target = index + delta;
    if (index < 0 || target < 0 || target >= selectedDay.activities.length) return;
    const activities = [...selectedDay.activities]; [activities[index], activities[target]] = [activities[target], activities[index]]; updateDay({ ...selectedDay, activities });
  }
  async function recalculate() {
    if (!bundle || !plan) return; setWorking("正在重新计算路线");
    try {
      const response = await fetch("/api/planning/recalculate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request: bundle.request, plan }) });
      const data = await response.json() as Plan & { error?: string }; if (!response.ok) throw new Error(data.error);
      const now = new Date().toISOString();
      setManualDirty(false);
      setBundle((current) => current ? { ...current, plans: current.plans.map((item) => item.id === data.id ? data : item), revisions: [...current.revisions, { id: id("revision"), planId: data.id, version: data.version, parentVersion: plan.version, source: "manual", summary: "手动编辑并重新计算", createdAt: now, snapshot: data }], updatedAt: now } : current);
      setNotice(`已保存方案版本 v${data.version}`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "重算失败"); } finally { setWorking(""); }
  }
  async function addPlace() {
    if (!bundle || !selectedDay || !newPlace.trim()) return; setWorking("正在搜索景点资料");
    try {
      const response = await fetch("/api/places/enrich", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: newPlace, destination: bundle.request.destination }) });
      const place = await response.json() as Place & { error?: string }; if (!response.ok) throw new Error(place.error);
      const activity: Activity = { id: id("activity"), type: "place", place, startTime: "", endTime: "", durationMin: place.knowledge.suggestedDurationMin, note: place.knowledge.playTips[0] || "" };
      updateDay({ ...selectedDay, activities: [...selectedDay.activities, activity] }); setSelectedPlaceId(place.id); setNewPlace(""); setNotice("景点已加入，请重新计算路线");
    } catch (error) { setNotice(error instanceof Error ? error.message : "添加失败"); } finally { setWorking(""); }
  }
  async function share() {
    setWorking("正在创建只读快照");
    try { const response = await fetch("/api/shares", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bundle) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); await navigator.clipboard.writeText(`${location.origin}${data.url}`); setNotice("只读分享链接已复制"); } catch (error) { setNotice(error instanceof Error ? error.message : "分享失败"); } finally { setWorking(""); }
  }
  async function exportFile(format: "xlsx" | "pdf") {
    if (!bundle || !plan) return;
    const currentBundle = bundle;
    const currentPlan = plan;
    setWorking(`正在生成 ${format.toUpperCase()}`);
    try { const response = await fetch(`/api/exports/${format}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request: currentBundle.request, plan: currentPlan }) }); if (!response.ok) { const data = await response.json(); throw new Error(data.error); } downloadBlob(await response.blob(), `${currentBundle.request.destination}-${currentPlan.name}.${format}`); } catch (error) { setNotice(error instanceof Error ? error.message : "导出失败"); } finally { setWorking(""); }
  }

  return <main className={`planner-shell route-workspace ${readOnly ? "shared-workspace" : "agent-workspace"}`}>
    {!readOnly && <nav className="mobile-workspace-tabs"><button className={mobileView === "chat" ? "active" : ""} onClick={() => setMobileView("chat")}><MessageCircle />对话</button><button className={mobileView === "itinerary" ? "active" : ""} onClick={() => setMobileView("itinerary")}><Route />行程</button><button className={mobileView === "map" ? "active" : ""} onClick={() => setMobileView("map")}><Map />地图</button></nav>}
    {!readOnly && <AgentPanel session={session} bundle={bundle} working={working} onTurn={turn} onNewTrip={newTrip} onTripsOpen={() => setTripsOpen(true)} mobileActive={mobileView === "chat"} />}
    <MyTripsPanel open={tripsOpen} onClose={() => setTripsOpen(false)} />
    <section className={`route-canvas ${mobileView !== "chat" ? "mobile-active" : ""} mobile-${mobileView}`}>
      <TripMap plan={plan} selectedDayId={selectedDayId} onSelectPlace={selectPlace} />

      <header className="route-toolbar" aria-label="行程工具栏">
        <div className="route-heading"><button className="route-brand-mark" aria-label="开始新行程" onClick={newTrip}><Route /></button><div><small>{readOnly ? "SHARED ROADBOOK" : "YOUR ROADBOOK"}</small><strong>{bundle.request.destination} · {bundle.request.days} 日自驾</strong></div></div>
        <div className="route-plan-tabs">{bundle.plans.map((item, index) => <button key={item.id} className={plan.id === item.id ? "active" : ""} onClick={() => session ? turn({ type: "select_plan", planId: item.id }) : setBundle({ ...bundle, selectedPlanId: item.id, updatedAt: new Date().toISOString() })}><small>方案 {String.fromCharCode(65 + index)}</small><span>{item.name}</span></button>)}</div>
        <div className="route-stats"><span><b>{formatDistance(stats.distanceM)}</b>总里程</span><span><b>{formatHours(stats.driveS)}</b>自驾</span><span><b>{plan.days.slice(1).filter((day, index) => day.stay !== plan.days[index]?.stay).length}</b>次换宿</span></div>
        <div className="route-actions">{!readOnly && <span className={`trip-save-state ${manualDirty ? "dirty" : saveState}`}>{manualDirty ? "待重算" : saveState === "saving" ? "保存中" : saveState === "error" ? "保存失败" : "已保存"}</span>}<span className={`source-mode ${bundle.sourceMode}`}>{bundle.sourceMode === "live" ? "实时" : bundle.sourceMode === "mixed" ? "混合" : "演示"}</span>{!readOnly && <button title="重新计算路线" onClick={recalculate}><RefreshCw /></button>}<button title="分享行程" onClick={share}><Share2 /></button><button title="导出 Excel" onClick={() => exportFile("xlsx")}><Download /></button><Link href="/trips" title="已保存行程"><BookOpenText /></Link></div>
        <div className="canvas-switch" role="group" aria-label="画布视图"><button className={mobileView === "itinerary" ? "active" : ""} onClick={() => setMobileView("itinerary")}><Route />行程</button><button className={mobileView !== "itinerary" ? "active" : ""} onClick={() => setMobileView("map")}><Map />地图</button></div>
      </header>

      <div className="route-map-caption"><small>{selectedDayId ? `DAY ${selectedDay?.day}` : "ALL ROUTES"}</small><strong>{selectedDayId ? selectedDay?.title : plan.name}</strong><button onClick={() => { setSelectedDayId(undefined); setDrawerOpen(false); }}><Map />查看全程</button></div>

      <aside className="route-alert-card">
        <span><CircleAlert /></span><div><small>沿途提示</small><strong>{selectedDay?.issues[0]?.message || `${selectedDay?.title}路线已校验，可按当前节奏出发。`}</strong></div>
      </aside>

      <section className="day-dock" aria-label="每日路书">
        <header><div><small>DAILY ROADBOOK</small><strong>{plan.name}</strong></div><span>{plan.tagline}</span><button onClick={() => setSelectedDayId(undefined)}><Map />全程</button></header>
        <div className="day-dock-track">{plan.days.map((day) => <button key={day.id} className={`day-dock-card ${day.id === selectedDay?.id ? "active" : ""}`} onClick={() => selectDay(day)}><span className={`day-dock-number ${plan.accent}`}><small>DAY</small>{String(day.day).padStart(2, "0")}</span><div className="day-dock-copy"><strong>{day.title}</strong><p>{day.activities.map((item) => item.place.name).join(" · ")}</p><small><BedDouble />{day.stay}</small></div><div className="day-dock-metrics"><b>{formatDistance(day.totalDistanceM)}</b><span><CarFront />{formatHours(day.totalDriveS)}</span><em className={day.intensity}>{intensityLabels[day.intensity]}</em></div></button>)}</div>
      </section>

      <div className="map-legend route-legend"><span className={plan.accent} />精确路线 <i />估算路段</div>

      <section className={`detail-drawer route-detail-drawer ${drawerOpen ? "open" : ""}`}>
      <button className="drawer-close" onClick={() => setDrawerOpen(false)} aria-label="关闭详情"><X /></button>
      {selectedDay && <><header className="drawer-header"><div><small>DAY {selectedDay.day} / DETAIL</small><h2>{selectedDay.title}</h2><p><Route />{formatDistance(selectedDay.totalDistanceM)} · <Clock3 />{formatDuration(selectedDay.totalDriveS)} · <BedDouble />住 {selectedDay.stay}</p></div><em className={selectedDay.intensity}>{intensityLabels[selectedDay.intensity]}</em></header>
      {selectedActivity ? <PlaceDetail activity={selectedActivity} onBack={() => setSelectedPlaceId(undefined)} /> : <><div className="section-heading"><span>当天时间轴</span><small>调整后请重新计算</small></div><div className="timeline">{selectedDay.activities.map((activity, index) => <div className="timeline-item" key={activity.id} draggable={!readOnly} onDragStart={(event) => event.dataTransfer.setData("activity", activity.id)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { const source = event.dataTransfer.getData("activity"); const from = selectedDay.activities.findIndex((item) => item.id === source); if (from >= 0) moveActivity(source, index - from); }}><time>{activity.startTime || "待算"}</time><span className="timeline-dot" /><div><button className="place-title" onClick={() => setSelectedPlaceId(activity.place.id)}>{activity.place.name}<ChevronRight /></button><p>{activity.place.knowledge.highlights.slice(0, 2).join(" · ") || activity.place.knowledge.summary}</p><small>{formatDuration(activity.durationMin * 60)} · {activity.place.knowledge.status === "confirmed" ? "运营确认" : activity.place.knowledge.status === "auto" ? "自动整理" : "待确认"}</small></div>{!readOnly && <div className="reorder-actions"><GripVertical /><button aria-label="上移" onClick={() => moveActivity(activity.id, -1)}><ArrowUp /></button><button aria-label="下移" onClick={() => moveActivity(activity.id, 1)}><ArrowDown /></button><button aria-label="删除" onClick={() => updateDay({ ...selectedDay, activities: selectedDay.activities.filter((item) => item.id !== activity.id) })}><Trash2 /></button></div>}{selectedDay.segments[index] && <div className="segment-row"><CarFront />前往 {selectedDay.segments[index].toName}<b>{formatDistance(selectedDay.segments[index].distanceM)} · {formatDuration(selectedDay.segments[index].durationS)}</b>{selectedDay.segments[index].status !== "exact" && <em>估算</em>}{selectedDay.segments[index].navigationUrl && <a href={selectedDay.segments[index].navigationUrl} target="_blank"><ExternalLink />导航</a>}</div>}</div>)}</div>{!readOnly && <div className="add-place"><input value={newPlace} onChange={(event) => setNewPlace(event.target.value)} placeholder="增加一个景点" /><button onClick={addPlace}><Plus />搜索并加入</button></div>}<div className="stay-card"><BedDouble /><div><small>当晚住宿区域</small><input readOnly={readOnly} value={selectedDay.stay} onChange={(event) => updateDay({ ...selectedDay, stay: event.target.value })} /><p>{selectedDay.stayReason}</p></div></div>{selectedDay.issues.length > 0 && <div className="issues">{selectedDay.issues.map((issue) => <p key={issue.id} className={issue.level}><CircleAlert />{issue.message}</p>)}</div>}</>}</>}
      </section>
    </section>
    {(working && readOnly || notice) && <div className={`toast ${working ? "working" : ""}`} role="status" aria-live="polite">{working ? <LoaderCircle className="spin" /> : <Check />}{working || notice}<button onClick={() => setNotice("")}><X /></button></div>}
  </main>;
}

function PlaceDetail({ activity, onBack }: { activity: Activity; onBack: () => void }) {
  const place = activity.place; const knowledge = place.knowledge;
  return <div className="place-detail"><button className="back-link" onClick={onBack}>← 返回当天安排</button><div className="place-kicker"><MapPinned />{place.category}<span>{knowledge.status === "confirmed" ? "已确认" : knowledge.status === "auto" ? "自动整理" : "待确认"}</span></div><h3>{place.name}</h3><p className="place-summary">{knowledge.summary}</p><div className="detail-grid"><section><h4><Sparkles />这里有什么</h4><ul>{knowledge.highlights.map((item) => <li key={item}>{item}</li>)}</ul></section><section><h4><BookOpenText />怎么玩</h4><ol>{knowledge.playTips.map((item) => <li key={item}>{item}</li>)}</ol></section></div><div className="fact-row"><span><Clock3 />建议 {formatDuration(knowledge.suggestedDurationMin * 60)}</span><span><UsersRound />{knowledge.suitableFor.join("、") || "家庭游客"}</span></div>{(knowledge.openingHours || knowledge.reservation) && <div className="official-info"><strong>到访信息</strong>{knowledge.openingHours && <p>开放时间：{knowledge.openingHours}</p>}{knowledge.reservation && <p>预约：{knowledge.reservation}</p>}</div>}{knowledge.cautions.length > 0 && <div className="cautions"><strong>出发前留意</strong>{knowledge.cautions.map((item) => <p key={item}>{item}</p>)}</div>}<section className="sources"><h4>资料来源 <small>更新于 {new Date(knowledge.updatedAt).toLocaleDateString("zh-CN")}</small></h4>{knowledge.sources.length ? knowledge.sources.map((source) => <a href={source.url} target="_blank" key={source.id}><span>{source.official ? "官方" : "来源"}</span><div><strong>{source.title}</strong><small>{source.siteName}</small></div><ExternalLink /></a>) : <p>暂未获得可引用的网络来源，信息已标记待确认。</p>}</section></div>;
}
