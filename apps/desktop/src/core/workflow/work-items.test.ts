import { describe, expect, it } from "vitest";
import type { TaskRun } from "./task-runs";
import { type StageFacts, itemStage } from "./work-items";

/**
 * 阶段由事实推出（#682），首个命中即答。逐条守住顺序：前面的条件在后面的也成立
 * 时照样赢。
 */

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    taskId: "t1",
    coordinatorNodeId: "lead",
    runnerId: "codex",
    nodeId: "member",
    status: "running",
    startedAt: 0,
    endedAt: null,
    result: null,
    title: "t",
    origin: null,
    mandate: null,
    report: null,
    attention: null,
    ...overrides,
  };
}

const NONE: StageFacts = { deliveryFailed: false, queued: false, idle: false };

function report(
  state: NonNullable<TaskRun["report"]>["state"],
): TaskRun["report"] {
  return { state, summary: "s", at: 1 };
}

describe("itemStage", () => {
  it("投递失败排第一，但只在任务还在跑时", () => {
    const failed = { ...NONE, deliveryFailed: true };
    expect(
      itemStage(run({ attention: { question: "q", raisedAt: 1 } }), failed),
    ).toBe("person/delivery");
    expect(itemStage(run({ status: "done" }), failed)).toBe("done");
  });

  it("待决问题先于报告", () => {
    expect(
      itemStage(
        run({
          attention: { question: "q", raisedAt: 1 },
          report: report("ready"),
        }),
        NONE,
      ),
    ).toBe("person/answer");
  });

  it("ready 等验收，结束了也一样", () => {
    expect(itemStage(run({ report: report("ready") }), NONE)).toBe(
      "person/review",
    );
    expect(
      itemStage(run({ report: report("ready"), status: "done" }), NONE),
    ).toBe("person/review");
  });

  it("blocked / failed 报告，或任务本身失败", () => {
    expect(itemStage(run({ report: report("blocked") }), NONE)).toBe(
      "person/blocked",
    );
    expect(itemStage(run({ report: report("failed") }), NONE)).toBe(
      "person/failed",
    );
    expect(itemStage(run({ status: "failed" }), NONE)).toBe("person/failed");
  });

  it("结束且不等人：done / stopped", () => {
    expect(itemStage(run({ status: "done" }), NONE)).toBe("done");
    expect(itemStage(run({ status: "stopped" }), NONE)).toBe("stopped");
  });

  it("还没起来是 working/queued，先于 idle", () => {
    expect(
      itemStage(run({ report: report("waiting") }), { ...NONE, queued: true }),
    ).toBe("working/queued");
  });

  it("报 waiting 或空闲无未读是 idle，其余是 working", () => {
    expect(itemStage(run({ report: report("waiting") }), NONE)).toBe("idle");
    expect(itemStage(run(), { ...NONE, idle: true })).toBe("idle");
    expect(itemStage(run({ report: report("progress") }), NONE)).toBe(
      "working",
    );
    expect(itemStage(run(), NONE)).toBe("working");
  });
});
