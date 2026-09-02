"use client";

import { useEffect, useMemo } from "react";
import L from "leaflet";
import { MapContainer, Marker, Polyline, Popup, TileLayer, Tooltip, useMap, ZoomControl } from "react-leaflet";
import type { DayPlan, Plan, Place } from "@/lib/domain";

/** 按天路线调色板：相邻天颜色不同，超过 8 天后循环复用（首尾若同色可呼应环线闭环）。 */
const DAY_COLORS = ["#d9480f", "#2f9e44", "#1c7ed6", "#e67700", "#9c36b5", "#0c8599", "#c92a2a", "#5f3dc4"];

function dayColor(day: number) {
  return DAY_COLORS[(day - 1) % DAY_COLORS.length];
}

function FitRoute({ days }: { days: DayPlan[] }) {
  const map = useMap();
  useEffect(() => {
    // 同时纳入路线几何点：segments 首段可能是“前日住宿地 → 今日第一景点”，视野需覆盖出发地/住宿地
    const points = days.flatMap((day) => [
      ...day.activities.map((activity) => [activity.place.location.lat, activity.place.location.lng] as [number, number]),
      ...day.segments.flatMap((segment) => segment.geometry.map((point) => [point.lat, point.lng] as [number, number])),
    ]);
    if (points.length === 1) map.setView(points[0], 9);
    else if (points.length > 1) map.fitBounds(L.latLngBounds(points), { padding: [50, 50] });
  }, [days, map]);
  return null;
}

function markerIcon(day: number, index: number, color: string) {
  return L.divIcon({
    className: "atlas-marker-wrap",
    html: `<span class="atlas-marker" style="background:${color}"><small>D${day}</small>${index + 1}</span>`,
    iconSize: [38, 46], iconAnchor: [19, 43], popupAnchor: [0, -38],
  });
}

/** 当日路线折线点：逐段取 geometry；段与段共享端点，视觉无缝。geometry 缺失时跳过该段（避免错误直连）。 */
function dayLinePoints(day: DayPlan): [number, number][] {
  return day.segments.flatMap((segment) => (segment.geometry.length > 1 ? segment.geometry.map((point) => [point.lat, point.lng] as [number, number]) : []));
}

export default function TripMap({ plan, selectedDayId, onSelectPlace }: { plan: Plan; selectedDayId?: string; onSelectPlace: (place: Place, dayId: string) => void }) {
  const days = useMemo(() => selectedDayId ? plan.days.filter((day) => day.id === selectedDayId) : plan.days, [plan, selectedDayId]);
  const center = days[0]?.activities[0]?.place.location ?? { lat: 35.8617, lng: 104.1954 };
  return (
    <MapContainer center={[center.lat, center.lng]} zoom={6} className="trip-map" zoomControl={false}>
      <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
      <ZoomControl position="bottomleft" />
      <FitRoute days={days} />
      {/* 图例：标注每天颜色 */}
      {!selectedDayId && <div className="leaflet-top leaflet-right"><div className="leaflet-control day-legend" aria-label="每日路线颜色图例">
        {plan.days.map((day) => <span key={day.id} className="day-legend-item" title={`第${day.day}天`}><i style={{ background: dayColor(day.day) }} />D{day.day}</span>)}
      </div></div>}
      {/* 路线：每天一条独立折线（含出发段/入住段），按天着色 */}
      {days.map((day) => {
        const points = dayLinePoints(day);
        if (points.length < 2) return null;
        return <Polyline key={`line-${day.id}`} positions={points} pathOptions={{ color: dayColor(day.day), weight: 5, opacity: 0.85 }} />;
      })}
      {days.flatMap((day) => day.activities.map((activity, index) => (
        <Marker key={`${day.id}-${activity.id}`} position={[activity.place.location.lat, activity.place.location.lng]} icon={markerIcon(day.day, index, dayColor(day.day))} eventHandlers={{ click: () => onSelectPlace(activity.place, day.id) }}>
          <Tooltip permanent direction="top" offset={[0, -39]} className="place-label">{activity.place.name}</Tooltip>
          <Popup>
            <div className="map-popup"><strong>{activity.place.name}</strong><p>{activity.place.knowledge.summary}</p><button onClick={() => onSelectPlace(activity.place, day.id)}>查看玩法</button></div>
          </Popup>
        </Marker>
      )))}
    </MapContainer>
  );
}
