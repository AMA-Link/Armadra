import { describe, expect, it } from "vitest";
import type { TimelineItem } from "@armadra/shared";

import { isPlanApproval } from "./plan-card";

const base = { turn: 1, ord: 1, rev: 1, source: "acp", at: 1, gen: 0 } as const;
const approval = (card?: string): TimelineItem =>
  ({
    ...base,
    id: "ap:p1",
    kind: "approval",
    pendingId: "p1",
    protocol: "acp",
    options: [],
    state: "pending",
    ...(card === undefined ? {} : { card }),
  }) as TimelineItem;

describe("isPlanApproval", () => {
  it("只有审批条目上 core 写的 card 是 plan 才算", () => {
    expect(isPlanApproval({ byId: { "ap:p1": approval("plan") } }, "p1")).toBe(
      true,
    );
    expect(isPlanApproval({ byId: { "ap:p1": approval() } }, "p1")).toBe(false);
    // 以后多一种卡片：旧页面当普通审批。
    expect(
      isPlanApproval({ byId: { "ap:p1": approval("future") } }, "p1"),
    ).toBe(false);
  });

  it("条目还没到、没有 pendingId、别的 id：答 false（保持原来的行为）", () => {
    expect(isPlanApproval(undefined, "p1")).toBe(false);
    expect(isPlanApproval({ byId: {} }, "p1")).toBe(false);
    expect(
      isPlanApproval({ byId: { "ap:p1": approval("plan") } }, undefined),
    ).toBe(false);
    expect(isPlanApproval({ byId: { "ap:p1": approval("plan") } }, "p2")).toBe(
      false,
    );
  });
});
