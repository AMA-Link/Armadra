import { describe, expect, it } from "vitest";
import { WORK_ITEM_STAGES } from "@armadra/shared";
import { type ItemStageFacts, itemStage, stageRank } from "./work-items";

/** `itemStage`：每个分支各一条，再加「顺序」——先命中的赢。 */

const QUIET: ItemStageFacts = {
  deliveryFailed: false,
  attention: false,
  report: null,
  runStatus: "running",
  queued: false,
  nodeIdle: false,
  unread: false,
};

const stage = (facts: Partial<ItemStageFacts>) =>
  itemStage({ ...QUIET, ...facts });

describe("itemStage", () => {
  it("person/delivery: the delivery to the member failed", () => {
    expect(stage({ deliveryFailed: true })).toBe("person/delivery");
  });

  it("person/answer: an open question", () => {
    expect(stage({ attention: true })).toBe("person/answer");
  });

  it("person/review: the last report is ready", () => {
    expect(stage({ report: "ready" })).toBe("person/review");
  });

  it("person/blocked: the last report is blocked", () => {
    expect(stage({ report: "blocked" })).toBe("person/blocked");
  });

  it("person/failed: the last report is failed, or the task row failed", () => {
    expect(stage({ report: "failed" })).toBe("person/failed");
    expect(stage({ runStatus: "failed" })).toBe("person/failed");
  });

  it("working/queued: not started or queued", () => {
    expect(stage({ queued: true })).toBe("working/queued");
  });

  it("idle: the last report is waiting, or the node is idle with nothing unread", () => {
    expect(stage({ report: "waiting" })).toBe("idle");
    expect(stage({ nodeIdle: true })).toBe("idle");
    // 空闲但收件箱里有没处理的：它马上要被唤醒，不算空闲。
    expect(stage({ nodeIdle: true, unread: true })).toBe("working");
  });

  it("working: everything else, including a progress report", () => {
    expect(stage({})).toBe("working");
    expect(stage({ report: "progress" })).toBe("working");
  });

  it("takes the first match in order", () => {
    const all: ItemStageFacts = {
      deliveryFailed: true,
      attention: true,
      report: "ready",
      runStatus: "failed",
      queued: true,
      nodeIdle: true,
      unread: false,
    };
    expect(itemStage(all)).toBe("person/delivery");
    expect(itemStage({ ...all, deliveryFailed: false })).toBe("person/answer");
    expect(itemStage({ ...all, deliveryFailed: false, attention: false })).toBe(
      "person/review",
    );
    expect(
      itemStage({
        ...all,
        deliveryFailed: false,
        attention: false,
        report: "blocked",
      }),
    ).toBe("person/blocked");
    expect(
      itemStage({
        ...all,
        deliveryFailed: false,
        attention: false,
        report: "waiting",
      }),
    ).toBe("person/failed");
    expect(
      itemStage({
        ...all,
        deliveryFailed: false,
        attention: false,
        report: "waiting",
        runStatus: "running",
      }),
    ).toBe("working/queued");
  });

  it("ranks person/* before the rest", () => {
    const ranks = WORK_ITEM_STAGES.map(stageRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(stageRank("person/review")).toBeLessThan(stageRank("working"));
    expect(stageRank("idle")).toBeLessThan(stageRank("working"));
  });
});
