import { NextResponse } from "next/server";
import { haversine, id } from "@/lib/utils";
import { FilePlaceRepository } from "@/server/repositories/files";
import { geocodeOrEstimate, matchRouteRegion, OsmMapProvider } from "@/server/providers/map";
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
    const destinationLocation = await map.geocodeDestination(destination);
    // geocodeDestination 已内置人工核实的区域中心表（环线类目的地优先于 Nominatim 结果），
    // 这里仅兜底再取一次，保证 destination 为空时仍可能拿到表内中心。
    const fallbackCenter = matchRouteRegion(destination);
    const effectiveCenter = fallbackCenter ?? destinationLocation?.location ?? null;
    const regionLimit = destination.length <= 3 ? 1_500_000 : 450_000;
    // 已有缓存若明显跑偏（远离所有有效中心，例如“茶卡盐湖”被记到香港）则丢弃，
    // 沿用“重新富集”路径，避免把历史错误坐标作为真值复用。
    const isObviouslyWrong = existing && effectiveCenter ? haversine(existing.location, effectiveCenter) > regionLimit * 4 : false;
    const distanceFromCenter = existing && effectiveCenter ? haversine(existing.location, effectiveCenter) : Number.POSITIVE_INFINITY;
    const withinRegion = existing && effectiveCenter ? distanceFromCenter <= regionLimit : false;
    const sameAsDestination = existing?.name === destination;
    // 当无法获取目的地中心时（destinationLocation 为空），回退到“任一不过期缓存即返回”的保守策略。
    const cacheValid = existing && Date.parse(existing.knowledge.expiresAt) > Date.now() && !isObviouslyWrong;
    if (cacheValid && (!destinationLocation || (sameAsDestination || (withinRegion && distanceFromCenter > 2_000)))) {
      return NextResponse.json(existing);
    }
    const location = effectiveCenter ? await geocodeOrEstimate(map, body.name.trim(), destination, effectiveCenter, 0) : null;
    const place = {
      id: existing?.id ?? id("place"),
      name: body.name.trim(), aliases: existing?.aliases ?? [], address: location?.address ?? `${destination}（位置待核实）`, category: existing?.category ?? "景点",
      location: location?.location ?? effectiveCenter ?? { lat: 35.8617, lng: 104.1954 }, locationStatus: location?.verified ? "verified" as const : "estimated" as const,
      knowledge: existing?.knowledge ?? await enrichKnowledge(body.name.trim()),
    };
    return NextResponse.json(await repository.save(place));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "景点资料获取失败" }, { status: 500 });
  }
}
