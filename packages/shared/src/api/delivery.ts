import { z } from "zod";

import { pullSnapshotSchema } from "./pulls.js";

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

/** GET /api/workspaces/:workspaceId/boards/:boardId/delivery */
export const deliveryNodeSchema = z.object({
  nodeId: z.string(),
  taskId: z.string().nullable(),
  lane: deliveryLaneSchema,
  phrase: z.string(),
  pulls: z.array(pullSnapshotSchema),
  /** When every PR left the board (merged or closed); null while any is open or there is none. */
  endedAtMs: z.number().nullable().optional(),
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
/** The workspace-event frame: the payload plus its type tag. */
export const deliveryChangedEventSchema = deliveryChangedPayloadSchema.extend({
  type: z.literal("delivery.changed"),
});
export type DeliveryChangedEvent = z.infer<typeof deliveryChangedEventSchema>;

export type DeliveryChangedPayload = z.infer<
  typeof deliveryChangedPayloadSchema
>;
