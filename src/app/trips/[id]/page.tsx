import { notFound } from "next/navigation";
import PlannerApp from "@/components/planner-app";
import { FileTripRepository } from "@/server/repositories/files";

export const dynamic = "force-dynamic";

export default async function SavedTripPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const bundle = await new FileTripRepository().get(id);
  if (!bundle) notFound();
  return <PlannerApp initialBundle={bundle} />;
}
