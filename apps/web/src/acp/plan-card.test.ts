import { describe, expect, it } from "vitest";

import { headerApprovalOf } from "./plan-card";

describe("headerApprovalOf", () => {
  it("普通审批（状态帧没有 pendingCard）：一键允许 / 拒绝照旧", () => {
    expect(headerApprovalOf({})).toEqual({ kind: "quick" });
    expect(headerApprovalOf(undefined)).toEqual({ kind: "quick" });
    expect(headerApprovalOf({ pendingCard: "" })).toEqual({ kind: "quick" });
  });

  it("计划审批：不出一键按钮，换成跳到卡片", () => {
    expect(headerApprovalOf({ pendingCard: "plan" })).toEqual({
      kind: "card",
      card: "plan",
    });
  });

  it("以后多一种卡片、这个页面不认得：同样不出一键按钮（宁可多一步，不盲批）", () => {
    expect(headerApprovalOf({ pendingCard: "future" })).toEqual({
      kind: "card",
      card: "future",
    });
  });
});
