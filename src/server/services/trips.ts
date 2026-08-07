import type { TripBundle, TripSummary } from "@/lib/domain";
import { summarizePlan } from "@/lib/utils";

export function summarizeTrip(bundle: TripBundle): TripSummary {
  const selected = bundle.plans.find((plan) => plan.id === bundle.selectedPlanId) ?? bundle.plans[0];
  const stats = summarizePlan(selected);
  return {
    id: bundle.id,
    destination: bundle.request.destination,
    days: bundle.request.days,
    planCount: bundle.plans.length,
    selectedPlanName: selected.name,
    planNames: bundle.plans.map((plan) => plan.name),
    totalDistanceM: stats.distanceM,
    totalDriveS: stats.driveS,
    sourceMode: bundle.sourceMode,
    createdAt: bundle.createdAt,
    updatedAt: bundle.updatedAt,
  };
}
