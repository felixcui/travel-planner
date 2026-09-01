import Link from "next/link";
import { ArrowRight, BookOpenText, CalendarDays, CarFront, MapPinned, Plus, Route } from "lucide-react";
import { formatDistance, formatHours } from "@/lib/utils";
import { FileTripRepository } from "@/server/repositories/files";
import { summarizeTrip } from "@/server/services/trips";

export const dynamic = "force-dynamic";

const sourceLabels = { live: "实时资料", mixed: "混合资料", demo: "演示降级" } as const;

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

export default async function TripsPage() {
  const bundles = await new FileTripRepository().list();
  const trips = bundles.map(summarizeTrip);
  return <main className="archive-shell">
    <header className="archive-header">
      <Link className="archive-brand" href="/"><span><Route /></span><div><small>ROADBOOK ARCHIVE</small><strong>去野 · 我的行程</strong></div></Link>
      <Link className="new-trip-button" href="/plan"><Plus />规划新旅程</Link>
    </header>
    <section className="archive-hero">
      <div><span className="archive-index">02</span><div><p>每一次出发都有迹可循</p><h1>已保存的<br /><em>旅行路书</em></h1></div></div>
      <aside><strong>{trips.length}</strong><span>份行程档案</span><small>生成完成后自动保存，后续调整也会同步更新。</small></aside>
    </section>
    {trips.length ? <section className="trip-archive-list">
      {trips.map((trip, index) => <Link className="trip-archive-card" href={`/trips/${trip.id}`} key={trip.id}>
        <span className="archive-card-number">{String(index + 1).padStart(2, "0")}</span>
        <div className="archive-card-main">
          <div className="archive-card-kicker"><MapPinned />{trip.destination}<span className={`archive-source ${trip.sourceMode}`}>{sourceLabels[trip.sourceMode]}</span></div>
          <h2>{trip.selectedPlanName}</h2>
          <p>{trip.planNames.map((name, planIndex) => `方案 ${String.fromCharCode(65 + planIndex)} · ${name}`).join("　/　")}</p>
          <time><CalendarDays />最后更新 {formatDate(trip.updatedAt)}</time>
        </div>
        <div className="archive-card-metrics">
          <div><strong>{trip.days}</strong><span>天</span></div>
          <div><strong>{formatDistance(trip.totalDistanceM)}</strong><span>里程</span></div>
          <div><strong>{formatHours(trip.totalDriveS)}</strong><span><CarFront />自驾</span></div>
        </div>
        <span className="archive-open">打开路书 <ArrowRight /></span>
      </Link>)}
    </section> : <section className="archive-empty"><BookOpenText /><span>NO ROADBOOK YET</span><h2>还没有保存的旅行规划</h2><p>完成第一次生成后，路线会自动出现在这里。</p><Link href="/plan">开始规划 <ArrowRight /></Link></section>}
  </main>;
}
