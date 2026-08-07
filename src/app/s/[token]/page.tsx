import { notFound } from "next/navigation";
import PlannerApp from "@/components/planner-app";
import { FileShareRepository } from "@/server/repositories/files";

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const bundle = await new FileShareRepository().get(token);
  if (!bundle) notFound();
  return <PlannerApp initialBundle={bundle} readOnly />;
}
