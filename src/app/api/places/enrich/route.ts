import { NextResponse } from "next/server";
import { haversine, id } from "@/lib/utils";
import { FilePlaceRepository } from "@/server/repositories/files";
import { geocodeOrEstimate, OsmMapProvider } from "@/server/providers/map";
import { enrichKnowledge } from "@/server/services/enrichment";

export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { name?: string; destination?: string };
    if (!body.name?.trim()) return NextResponse.json({ error: "请输入景点名称" }, { status: 400 });
    const repository = new FilePlaceRepository();
    const existing = await repository.findByName(body.name.trim());
    const map = new OsmMapProvider();
    const destination = body.destination || "中国";
    const destinationLocation = await map.geocode(destination, "中国");
    const regionLimit = destination.length <= 3 ? 1_500_000 : 450_000;
    const distanceFromCenter = existing && destinationLocation ? haversine(existing.location, destinationLocation.location) : Number.POSITIVE_INFINITY;
    if (existing && Date.parse(existing.knowledge.expiresAt) > Date.now() && (!destinationLocation || (distanceFromCenter <= regionLimit && (existing.name === destination || distanceFromCenter > 2_000)))) return NextResponse.json(existing);
    const location = destinationLocation ? await geocodeOrEstimate(map, body.name.trim(), destination, destinationLocation.location, 0) : null;
    const place = {
      id: existing?.id ?? id("place"),
      name: body.name.trim(), aliases: existing?.aliases ?? [], address: location?.address ?? `${destination}（位置待核实）`, category: existing?.category ?? "景点",
      location: location?.location ?? { lat: 35.8617, lng: 104.1954 }, locationStatus: location?.verified ? "verified" as const : "estimated" as const,
      knowledge: existing?.knowledge ?? await enrichKnowledge(body.name.trim()),
    };
    return NextResponse.json(await repository.save(place));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "景点资料获取失败" }, { status: 500 });
  }
}
