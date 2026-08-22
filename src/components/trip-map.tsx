"use client";

import { useEffect, useMemo } from "react";
import L from "leaflet";
import { MapContainer, Marker, Polyline, Popup, TileLayer, Tooltip, useMap, ZoomControl } from "react-leaflet";
import type { DayPlan, Plan, Place } from "@/lib/domain";

function FitRoute({ days }: { days: DayPlan[] }) {
  const map = useMap();
  useEffect(() => {
    const points = days.flatMap((day) => day.activities.map((activity) => [activity.place.location.lat, activity.place.location.lng] as [number, number]));
    if (points.length === 1) map.setView(points[0], 9);
    else if (points.length > 1) map.fitBounds(L.latLngBounds(points), { padding: [50, 50] });
  }, [days, map]);
  return null;
}

function markerIcon(day: number, index: number, accent: string) {
  return L.divIcon({
    className: "atlas-marker-wrap",
    html: `<span class="atlas-marker ${accent}"><small>D${day}</small>${index + 1}</span>`,
    iconSize: [38, 46], iconAnchor: [19, 43], popupAnchor: [0, -38],
  });
}

export default function TripMap({ plan, selectedDayId, onSelectPlace }: { plan: Plan; selectedDayId?: string; onSelectPlace: (place: Place, dayId: string) => void }) {
  const days = useMemo(() => selectedDayId ? plan.days.filter((day) => day.id === selectedDayId) : plan.days, [plan, selectedDayId]);
  const center = days[0]?.activities[0]?.place.location ?? { lat: 35.8617, lng: 104.1954 };
  return (
    <MapContainer center={[center.lat, center.lng]} zoom={6} className="trip-map" zoomControl={false}>
      <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
      <ZoomControl position="bottomleft" />
      <FitRoute days={days} />
      {days.map((day) => (
        <Polyline key={`line-${day.id}`} positions={day.segments.flatMap((segment) => segment.geometry.map((point) => [point.lat, point.lng] as [number, number]))} pathOptions={{ color: plan.accent === "vermillion" ? "#e5573f" : "#187865", weight: 6, opacity: 0.82 }} />
      ))}
      {days.flatMap((day) => day.activities.map((activity, index) => (
        <Marker key={`${day.id}-${activity.id}`} position={[activity.place.location.lat, activity.place.location.lng]} icon={markerIcon(day.day, index, plan.accent)} eventHandlers={{ click: () => onSelectPlace(activity.place, day.id) }}>
          <Tooltip permanent direction="top" offset={[0, -39]} className="place-label">{activity.place.name}</Tooltip>
          <Popup>
            <div className="map-popup"><strong>{activity.place.name}</strong><p>{activity.place.knowledge.summary}</p><button onClick={() => onSelectPlace(activity.place, day.id)}>查看玩法</button></div>
          </Popup>
        </Marker>
      )))}
    </MapContainer>
  );
}
