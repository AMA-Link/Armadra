import { describe, expect, it } from "vitest";

import { deliveryTooltip, supervisionTooltip } from "./link-tooltips";

const t = (key: string, vars?: Record<string, string | number>) =>
  `${key}${vars === undefined ? "" : JSON.stringify(vars)}`;

describe("连线悬停提示", () => {
  it("没有投递过就没有这句话", () => {
    expect(deliveryTooltip(undefined, t)).toBeNull();
  });

  it("说最近一次的结果与时刻，被拒的多说一句为什么", () => {
    const base = {
      sourceNodeId: "a",
      targetNodeId: "b",
      at: Date.now(),
    };
    const ok = deliveryTooltip({ ...base, outcome: "delivered" }, t);
    expect(ok).toContain("delivery.edge.last");
    expect(ok).not.toContain("error.delivery");

    const refused = deliveryTooltip(
      { ...base, outcome: "refused", code: "LOOP_DETECTED" },
      t,
    );
    expect(refused).toContain("delivery.edge.last");
    expect(refused).toContain("error.delivery.LOOP_DETECTED");
  });

  it("只有派发线说「主 → 从」，对等线没有", () => {
    expect(supervisionTooltip("supervises", "planner", "codex-1", t)).toBe(
      'edge.role.supervises{"supervisor":"planner","subordinate":"codex-1"}',
    );
    expect(supervisionTooltip(undefined, "a", "b", t)).toBeNull();
  });
});
