import { describe, expect, it } from "vitest";

import { dispatchTaskSchema } from "./api";

/**
 * 任务行的解析（契约 §15.7、§90）：旧 core 不答账本字段时取缺省；将来的 core 多
 * 一个阶段值时，这一行当作没有阶段，不让整张列表解析失败。
 */

const ROW = {
  taskId: "s1:t1",
  coordinatorNodeId: "lead",
  runnerId: "codex",
  nodeId: "m1",
  status: "running",
  startedAt: "2026-11-02T08:00:00.000Z",
  endedAt: null,
};

describe("dispatchTaskSchema", () => {
  it("keeps a known stage", () => {
    expect(
      dispatchTaskSchema.parse({ ...ROW, stage: "person/review" }).stage,
    ).toBe("person/review");
  });

  it("reads an unknown stage from a newer core as no stage", () => {
    expect(
      dispatchTaskSchema.parse({ ...ROW, stage: "person/later" }).stage,
    ).toBeNull();
  });

  it("defaults the ledger fields an older core does not send", () => {
    expect(dispatchTaskSchema.parse(ROW).stage).toBeNull();
  });
});
