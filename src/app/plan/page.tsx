import PlannerApp from "@/components/planner-app";

export default async function PlanPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  return <PlannerApp initialMessage={q?.slice(0, 2000)} />;
}
