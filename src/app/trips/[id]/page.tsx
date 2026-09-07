import { notFound } from "next/navigation";
import PlannerApp from "@/components/planner-app";
import { visitorRepositories } from "@/server/visitor";

export const dynamic = "force-dynamic";

export default async function SavedTripPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { trips } = await visitorRepositories();
  const bundle = await trips.get(id);
  if (!bundle) notFound();
  return <PlannerApp initialBundle={bundle} />;
}
