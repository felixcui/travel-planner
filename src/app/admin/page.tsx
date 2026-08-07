"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Check, Database, ExternalLink, KeyRound, LoaderCircle, LogOut, RefreshCw, Route, Search, ShieldCheck } from "lucide-react";
import type { Place } from "@/lib/domain";

export default function AdminPage() {
  const [authenticated, setAuthenticated] = useState(false);
  const [secret, setSecret] = useState("");
  const [places, setPlaces] = useState<Place[]>([]);
  const [usage, setUsage] = useState<{ search?: { used: number; limit: number; provider: string } | null }>();
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => { fetch("/api/admin/session").then((response) => response.json()).then((data) => { setAuthenticated(data.authenticated); setLoading(false); }); }, []);
  useEffect(() => { if (authenticated) loadData(); }, [authenticated]);
  async function loadData() {
    setLoading(true); const [placesResponse, usageResponse] = await Promise.all([fetch("/api/admin/places"), fetch("/api/admin/usage")]);
    if (placesResponse.ok) setPlaces(await placesResponse.json()); if (usageResponse.ok) setUsage(await usageResponse.json()); setLoading(false);
  }
  async function login(event: React.FormEvent) { event.preventDefault(); const response = await fetch("/api/admin/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret }) }); const data = await response.json(); if (response.ok) setAuthenticated(true); else setMessage(data.error); }
  async function logout() { await fetch("/api/admin/session", { method: "DELETE" }); setAuthenticated(false); setPlaces([]); }
  async function save(place: Place) { const response = await fetch("/api/admin/places", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(place) }); if (response.ok) { const saved = await response.json(); setPlaces((current) => current.map((item) => item.id === saved.id ? saved : item)); setMessage(`${saved.name} 已确认为运营版本`); } }
  function updatePlace(id: string, updater: (place: Place) => Place) { setPlaces((current) => current.map((place) => place.id === id ? updater(place) : place)); }

  if (loading && !authenticated) return <div className="admin-login"><LoaderCircle className="spin" /></div>;
  if (!authenticated) return <main className="admin-login"><form onSubmit={login}><div className="admin-logo"><Route /></div><small>LOCAL OPERATIONS</small><h1>运营资料台</h1><p>仅用于处理自动搜索冲突和锁定人工确认字段。</p><label><KeyRound /><input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder="输入 OPS_SECRET" /></label>{message && <em>{message}</em>}<button><ShieldCheck />进入运营台</button><Link href="/">← 返回旅行规划</Link></form></main>;

  return <main className="admin-shell"><aside><div className="admin-logo"><Route /></div><div><small>TRAVEL PLANNER</small><h1>运营资料台</h1></div><nav><a className="active"><Database />景点资料</a><a><Search />搜索记录</a></nav><button onClick={logout}><LogOut />退出</button></aside><section className="admin-content"><header><div><small>PLACE KNOWLEDGE</small><h2>景点知识库</h2><p>自动搜索为主，只有人工确认的字段会被锁定。</p></div><button onClick={loadData}><RefreshCw className={loading ? "spin" : ""} />刷新</button></header>
    <div className="admin-stats"><article><span>Tavily 用量</span><strong>{usage?.search ? `${usage.search.used} / ${usage.search.limit}` : "暂不可用"}</strong><small>当前密钥额度</small></article><article><span>景点资料</span><strong>{places.length}</strong><small>文件仓储记录</small></article><article><span>待确认</span><strong>{places.filter((place) => place.knowledge.status === "needs_review").length}</strong><small>需要运营关注</small></article></div>
    {message && <div className="admin-message"><Check />{message}</div>}
    <div className="place-admin-list">{places.length ? places.map((place) => <article key={place.id}><header><div><span className={place.knowledge.status}>{place.knowledge.status === "confirmed" ? "运营确认" : place.knowledge.status === "auto" ? "自动整理" : "待确认"}</span><h3>{place.name}</h3><small>{place.address}</small></div><button onClick={() => save(place)}><ShieldCheck />确认并锁定</button></header><label>景点特点<textarea value={place.knowledge.summary} onChange={(event) => updatePlace(place.id, (current) => ({ ...current, knowledge: { ...current.knowledge, summary: event.target.value } }))} /></label><label>推荐玩法<textarea value={place.knowledge.playTips.join("\n")} onChange={(event) => updatePlace(place.id, (current) => ({ ...current, knowledge: { ...current.knowledge, playTips: event.target.value.split("\n").filter(Boolean) } }))} /></label><footer><span>来源 {place.knowledge.sources.length} 个 · 更新 {new Date(place.knowledge.updatedAt).toLocaleString("zh-CN")}</span>{place.knowledge.sources.slice(0, 3).map((source) => <a key={source.id} href={source.url} target="_blank">{source.siteName}<ExternalLink /></a>)}</footer></article>) : <div className="admin-empty"><Database /><h3>还没有景点资料</h3><p>生成第一份行程后，Tavily 搜索结果会出现在这里。</p></div>}</div>
  </section></main>;
}
