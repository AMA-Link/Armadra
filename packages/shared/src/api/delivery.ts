import { z } from "zod";

/**
 * Delivery status of an Agent node (Armadra#988): four board lanes plus
 * "off board", each with a fixed phrase set. The lane and phrase are derived
 * by core's `deliveryStatus`; this file is the wire shape only.
 */

export const DELIVERY_LANES = [
  "working",
  "needsYou",
  "inReview",
  "readyToMerge",
  "offBoard",
] as const;
export type DeliveryLane = (typeof DELIVERY_LANES)[number];
export const deliveryLaneSchema = z.enum(DELIVERY_LANES);

export const DELIVERY_PHRASES = {
  working: [
    "working",
    "queued",
    "fixingCi",
    "addressingReview",
    "resolvingConflicts",
    "draft",
    "idle",
  ],
  needsYou: [
    "needsApproval",
    "needsAnswer",
    "readyForReview",
    "blocked",
    "failed",
    "deliveryFailed",
    "interrupted",
    "exited",
    "noSignal",
    "ciFailing",
    "mergeConflicts",
    "changesRequested",
  ],
  inReview: [
    "awaitingReview",
    "checksRunning",
    "waitingOnBase",
    "mergeabilityUnknown",
  ],
  readyToMerge: ["mergeable", "approved"],
  offBoard: ["merged", "closed"],
} as const;

export type DeliveryPhrase<L extends DeliveryLane = DeliveryLane> =
  (typeof DELIVERY_PHRASES)[L][number];

export type DeliveryStatus = {
  [L in DeliveryLane]: {
    lane: L;
    phrase: (typeof DELIVERY_PHRASES)[L][number];
  };
}[DeliveryLane];

export const deliveryStatusSchema = z.union(
  DELIVERY_LANES.map((lane) =>
    z.object({
      lane: z.literal(lane),
      phrase: z.enum(DELIVERY_PHRASES[lane]),
    }),
  ) as unknown as [
    z.ZodObject<{ lane: z.ZodLiteral<DeliveryLane>; phrase: z.ZodString }>,
    ...z.ZodObject<{ lane: z.ZodLiteral<DeliveryLane>; phrase: z.ZodString }>[],
  ],
) as unknown as z.ZodType<DeliveryStatus>;

// TODO(#988): once P1 lands, replace the shapes below with `PullSnapshot` from
// ./pulls.ts. They mirror the frozen P1 definition exactly.
const deliveryPullReviewSchema = z.enum([
  "approved",
  "changesRequested",
  "reviewRequired",
  "notRequired",
  "unknown",
]);
const deliveryPullChecksSchema = z.discriminatedUnion("read", [
  z.object({
    read: z.literal(true),
    headSha: z.string(),
    rollup: z.enum(["pending", "success", "failure", "neutral", "none"]),
    failing: z.array(z.string()),
  }),
  z.object({ read: z.literal(false) }),
]);
const deliveryPullParentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("open"),
    number: z.number().int(),
    url: z.string(),
  }),
  z.object({ kind: z.literal("unknown") }),
]);
export const deliveryPullSchema = z.object({
  repo: z.string(),
  number: z.number().int(),
  url: z.string(),
  title: z.string(),
  state: z.enum(["open", "merged", "closed"]),
  draft: z.boolean(),
  baseRef: z.string(),
  headRef: z.string(),
  headSha: z.string(),
  fromFork: z.boolean(),
  review: deliveryPullReviewSchema,
  checks: deliveryPullChecksSchema,
  mergeable: z.enum(["mergeable", "conflicting", "unknown"]),
  parent: deliveryPullParentSchema,
  fetchedAtMs: z.number(),
  stale: z.boolean(),
});
export type DeliveryPull = z.infer<typeof deliveryPullSchema>;

/** GET /api/workspaces/:workspaceId/boards/:boardId/delivery */
export const deliveryNodeSchema = z.object({
  nodeId: z.string(),
  taskId: z.string().nullable(),
  lane: deliveryLaneSchema,
  phrase: z.string(),
  pulls: z.array(deliveryPullSchema),
});
export type DeliveryNode = z.infer<typeof deliveryNodeSchema>;

export const deliveryBoardResponseSchema = z.object({
  nodes: z.array(deliveryNodeSchema),
});
export type DeliveryBoardResponse = z.infer<typeof deliveryBoardResponseSchema>;

/** `delivery.changed` event payload; carries no PR body. */
export const deliveryChangedPayloadSchema = z.object({
  boardId: z.string(),
  nodeId: z.string(),
  lane: deliveryLaneSchema,
  phrase: z.string(),
  /** PR details changed while lane and phrase did not: re-read the route. */
  pullsChanged: z.boolean().optional(),
});
export type DeliveryChangedPayload = z.infer<
  typeof deliveryChangedPayloadSchema
>;
