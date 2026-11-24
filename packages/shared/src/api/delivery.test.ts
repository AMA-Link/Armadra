import { describe, expect, it } from "vitest";

import {
  DELIVERY_LANES,
  DELIVERY_PHRASES,
  deliveryBoardResponseSchema,
  deliveryChangedPayloadSchema,
  deliveryStatusSchema,
} from "./delivery.js";

describe("delivery wire schemas", () => {
  it("accepts every lane/phrase pair and nothing across lanes", () => {
    for (const lane of DELIVERY_LANES) {
      for (const phrase of DELIVERY_PHRASES[lane]) {
        expect(deliveryStatusSchema.safeParse({ lane, phrase }).success).toBe(
          true,
        );
      }
    }
    expect(
      deliveryStatusSchema.safeParse({ lane: "working", phrase: "merged" })
        .success,
    ).toBe(false);
  });

  it("parses the route response and the event frame", () => {
    expect(
      deliveryBoardResponseSchema.safeParse({
        nodes: [
          {
            nodeId: "n",
            taskId: null,
            lane: "needsYou",
            phrase: "failed",
            pulls: [],
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      deliveryChangedPayloadSchema.safeParse({
        boardId: "b",
        nodeId: "n",
        lane: "inReview",
        phrase: "checksRunning",
        pullsChanged: true,
      }).success,
    ).toBe(true);
    expect(
      deliveryChangedPayloadSchema.safeParse({ boardId: "b" }).success,
    ).toBe(false);
  });
});

describe("delivery children", () => {
  const node = {
    nodeId: "n",
    taskId: null,
    lane: "working",
    phrase: "waitingOnChildren",
    pulls: [],
  };
  const parse = (extra: object) =>
    deliveryBoardResponseSchema.safeParse({ nodes: [{ ...node, ...extra }] })
      .success;

  it("appends the child phrases at the end of the working lane", () => {
    expect(DELIVERY_PHRASES.working.slice(-2)).toEqual([
      "waitingOnChildren",
      "collecting",
    ]);
  });

  it("parses children when absent, null or present", () => {
    expect(parse({})).toBe(true);
    expect(parse({ children: null })).toBe(true);
    expect(
      parse({
        children: {
          total: 2,
          finished: 1,
          needsYou: 0,
          nodes: [{ nodeId: "c", source: "task", finished: false }],
        },
      }),
    ).toBe(true);
    expect(
      parse({ children: { total: -1, finished: 0, needsYou: 0, nodes: [] } }),
    ).toBe(false);
  });

  it("carries counts only on the event payload", () => {
    const base = {
      boardId: "b",
      nodeId: "n",
      lane: "working",
      phrase: "collecting",
    };
    expect(deliveryChangedPayloadSchema.safeParse(base).success).toBe(true);
    expect(
      deliveryChangedPayloadSchema.safeParse({
        ...base,
        children: { total: 1, finished: 1, needsYou: 0 },
      }).success,
    ).toBe(true);
  });
});

describe("delivery.changed as a workspace event", () => {
  it("is part of the workspace event union", async () => {
    const { workspaceEventSchema } = await import("./events.js");
    const frame = {
      type: "delivery.changed",
      boardId: "b",
      nodeId: "n",
      lane: "inReview",
      phrase: "checksRunning",
    };
    expect(workspaceEventSchema.safeParse(frame).success).toBe(true);
    expect(
      workspaceEventSchema.safeParse({ ...frame, lane: "nope" }).success,
    ).toBe(false);
  });
});
