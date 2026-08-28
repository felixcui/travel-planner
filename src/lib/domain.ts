import { z } from "zod";

export const CoordinateSchema = z.object({ lat: z.number(), lng: z.number() });
export type Coordinate = z.infer<typeof CoordinateSchema>;

export const SourceEvidenceSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string().url(),
  siteName: z.string(),
  snippet: z.string(),
  score: z.number().min(0).max(1).default(0),
  publishedAt: z.string().optional(),
  retrievedAt: z.string(),
  provider: z.string(),
  supports: z.array(z.string()).default([]),
  official: z.boolean().default(false),
});
export type SourceEvidence = z.infer<typeof SourceEvidenceSchema>;

export const PlaceKnowledgeSchema = z.object({
  summary: z.string(),
  highlights: z.array(z.string()).default([]),
  playTips: z.array(z.string()).default([]),
  suggestedDurationMin: z.number().int().positive().default(120),
  suitableFor: z.array(z.string()).default([]),
  openingHours: z.string().optional(),
  reservation: z.string().optional(),
  cautions: z.array(z.string()).default([]),
  status: z.enum(["confirmed", "auto", "needs_review"]).default("auto"),
  updatedAt: z.string(),
  expiresAt: z.string(),
  lockedFields: z.array(z.string()).default([]),
  sources: z.array(SourceEvidenceSchema).default([]),
});
export type PlaceKnowledge = z.infer<typeof PlaceKnowledgeSchema>;

export const PlaceSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  address: z.string().default(""),
  category: z.string().default("景点"),
  location: CoordinateSchema,
  locationStatus: z.enum(["verified", "estimated"]).default("verified"),
  knowledge: PlaceKnowledgeSchema,
});
export type Place = z.infer<typeof PlaceSchema>;

export const TripRequestSchema = z.object({
  destination: z.string().min(2, "请输入目的地"),
  days: z.number().int().min(1).max(30),
  adults: z.number().int().min(1).max(20).default(2),
  children: z.number().int().min(0).max(10).default(0),
  childAges: z.array(z.number().int().min(0).max(17)).default([]),
  seniors: z.number().int().min(0).max(10).default(0),
  pace: z.enum(["relaxed", "balanced", "compact"]).default("balanced"),
  interests: z.array(z.string()).default([]),
  mustGo: z.array(z.string()).default([]),
  avoid: z.array(z.string()).default([]),
  startPoint: z.string().optional(),
  endPoint: z.string().optional(),
  earliestDeparture: z.string().regex(/^\d{2}:\d{2}$/).default("09:00"),
  latestArrival: z.string().regex(/^\d{2}:\d{2}$/).default("19:30"),
  maxDriveHours: z.number().min(1).max(12).default(5),
  month: z.string().optional(),
  notes: z.string().default(""),
});
export type TripRequest = z.infer<typeof TripRequestSchema>;

export const RouteSegmentSchema = z.object({
  id: z.string(),
  fromPlaceId: z.string(),
  toPlaceId: z.string(),
  fromName: z.string(),
  toName: z.string(),
  distanceM: z.number().nonnegative(),
  durationS: z.number().nonnegative(),
  status: z.enum(["exact", "estimated", "unavailable"]),
  provider: z.string(),
  calculatedAt: z.string(),
  geometry: z.array(CoordinateSchema).default([]),
  navigationUrl: z.string().url().optional(),
});
export type RouteSegment = z.infer<typeof RouteSegmentSchema>;

export const ActivitySchema = z.object({
  id: z.string(),
  type: z.enum(["place", "meal", "rest", "stay"]),
  place: PlaceSchema,
  startTime: z.string().default(""),
  endTime: z.string().default(""),
  durationMin: z.number().int().nonnegative(),
  note: z.string().default(""),
});
export type Activity = z.infer<typeof ActivitySchema>;

export const ValidationIssueSchema = z.object({
  id: z.string(),
  level: z.enum(["info", "warning", "error"]),
  code: z.string(),
  message: z.string(),
});
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

export const DayPlanSchema = z.object({
  id: z.string(),
  day: z.number().int().positive(),
  title: z.string(),
  activities: z.array(ActivitySchema),
  segments: z.array(RouteSegmentSchema),
  stay: z.string(),
  stayReason: z.string().default("方便衔接次日行程"),
  totalDistanceM: z.number().nonnegative(),
  totalDriveS: z.number().nonnegative(),
  intensity: z.enum(["relaxed", "balanced", "tiring", "not_recommended"]),
  issues: z.array(ValidationIssueSchema).default([]),
});
export type DayPlan = z.infer<typeof DayPlanSchema>;

export const PlanSchema = z.object({
  id: z.string(),
  name: z.string(),
  tagline: z.string(),
  accent: z.enum(["vermillion", "pine"]),
  version: z.number().int().positive(),
  createdAt: z.string(),
  days: z.array(DayPlanSchema),
});
export type Plan = z.infer<typeof PlanSchema>;

export const PlanRevisionSchema = z.object({
  id: z.string(),
  planId: z.string(),
  version: z.number().int().positive(),
  parentVersion: z.number().int().positive().optional(),
  source: z.enum(["generated", "agent", "manual", "restored"]),
  summary: z.string(),
  createdAt: z.string(),
  snapshot: PlanSchema,
});
export type PlanRevision = z.infer<typeof PlanRevisionSchema>;

export const LegacyTripBundleSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  request: TripRequestSchema,
  plans: z.array(PlanSchema).min(1),
  selectedPlanId: z.string(),
  sourceMode: z.enum(["live", "mixed", "demo"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const TripBundleSchema = z.object({
  schemaVersion: z.literal(2),
  id: z.string(),
  request: TripRequestSchema,
  plans: z.array(PlanSchema).min(1),
  selectedPlanId: z.string(),
  sourceMode: z.enum(["live", "mixed", "demo"]),
  agentSessionId: z.string().optional(),
  revisions: z.array(PlanRevisionSchema).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TripBundle = z.infer<typeof TripBundleSchema>;

export function migrateTripBundle(input: unknown): TripBundle {
  const current = TripBundleSchema.safeParse(input);
  if (current.success) return current.data;
  const legacy = LegacyTripBundleSchema.parse(input);
  return TripBundleSchema.parse({
    ...legacy,
    schemaVersion: 2,
    revisions: legacy.plans.map((plan) => ({
      id: `revision_${plan.id}_${plan.version}`,
      planId: plan.id,
      version: plan.version,
      source: "generated",
      summary: "从旧版行程迁移",
      createdAt: plan.createdAt,
      snapshot: plan,
    })),
  });
}

const TripBriefFields = ["destination", "days", "adults", "children", "childAges", "seniors", "pace", "interests", "mustGo", "avoid", "startPoint", "endPoint", "earliestDeparture", "latestArrival", "maxDriveHours", "month", "notes"] as const;

export const TripBriefDraftSchema = TripRequestSchema.partial().extend({
  confirmedFields: z.array(z.enum(TripBriefFields)).default([]),
});
export type TripBriefDraft = z.infer<typeof TripBriefDraftSchema>;

export const AgentMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  kind: z.enum(["text", "question", "brief", "comparison", "change_preview", "status", "error"]).default("text"),
  content: z.string(),
  quickReplies: z.array(z.string()).default([]),
  createdAt: z.string(),
});
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export const PlanChangeOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add_place"), day: z.number().int().positive(), placeName: z.string() }),
  z.object({ type: z.literal("remove_place"), day: z.number().int().positive(), placeName: z.string() }),
  z.object({ type: z.literal("replace_place"), day: z.number().int().positive(), placeName: z.string(), replacement: z.string() }),
  z.object({ type: z.literal("move_place"), day: z.number().int().positive(), placeName: z.string(), direction: z.enum(["earlier", "later"]) }),
  z.object({ type: z.literal("update_stay"), day: z.number().int().positive(), stay: z.string() }),
  z.object({ type: z.literal("lighten_day"), day: z.number().int().positive() }),
]);
export type PlanChangeOperation = z.infer<typeof PlanChangeOperationSchema>;

export const PlanMetricsSchema = z.object({
  distanceM: z.number().nonnegative(),
  driveS: z.number().nonnegative(),
  tiringDays: z.number().int().nonnegative(),
  placeCount: z.number().int().nonnegative(),
});

export const PlanChangeSetSchema = z.object({
  id: z.string(),
  planId: z.string(),
  baseVersion: z.number().int().positive(),
  summary: z.string(),
  affectedDays: z.array(z.number().int().positive()),
  operations: z.array(PlanChangeOperationSchema).min(1),
  before: PlanMetricsSchema,
  after: PlanMetricsSchema,
  proposedPlan: PlanSchema,
  createdAt: z.string(),
});
export type PlanChangeSet = z.infer<typeof PlanChangeSetSchema>;

export const AgentSessionSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  stage: z.enum(["collecting", "ready", "generating", "comparing", "editing"]),
  brief: TripBriefDraftSchema,
  interviewQueue: z.array(z.string()).default([]),
  messages: z.array(AgentMessageSchema),
  tripId: z.string().optional(),
  pendingChange: PlanChangeSetSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgentSession = z.infer<typeof AgentSessionSchema>;

export type AgentEvent =
  | { type: "ack" | "progress"; message: string }
  | { type: "session"; session: AgentSession }
  | { type: "trip"; trip: TripBundle }
  | { type: "error"; message: string };

export const TripSummarySchema = z.object({
  id: z.string(),
  destination: z.string(),
  days: z.number().int().positive(),
  planCount: z.number().int().positive(),
  selectedPlanName: z.string(),
  planNames: z.array(z.string()),
  totalDistanceM: z.number().nonnegative(),
  totalDriveS: z.number().nonnegative(),
  sourceMode: z.enum(["live", "mixed", "demo"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TripSummary = z.infer<typeof TripSummarySchema>;

export const SearchResultSchema = z.object({
  title: z.string(),
  url: z.string().url(),
  snippet: z.string(),
  score: z.number().min(0).max(1),
  publishedAt: z.string().optional(),
  rawContent: z.string().optional(),
  provider: z.string(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const SearchOptionsSchema = z.object({
  depth: z.enum(["basic", "advanced"]).default("basic"),
  maxResults: z.number().int().min(1).max(10).default(5),
  country: z.string().default("china"),
  includeDomains: z.array(z.string()).optional(),
});
export type SearchOptions = z.infer<typeof SearchOptionsSchema>;
