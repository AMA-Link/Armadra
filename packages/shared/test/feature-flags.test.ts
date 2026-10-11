import { describe, expect, it } from "vitest";

import { FEATURE_FLAGS, featureEnabled } from "../src/index.js";

describe("功能开关（#295）", () => {
  it("五项暂时下线的功能默认关", () => {
    expect(FEATURE_FLAGS).toEqual({
      credentials: false,
      usage: false,
      activityCards: false,
      scheduledTasks: false,
      workflows: false,
    });
    expect(featureEnabled("usage")).toBe(false);
  });

  it("可以传入另一张表（恢复时只改常量）", () => {
    const on = { ...FEATURE_FLAGS, workflows: true };
    expect(featureEnabled("workflows", on)).toBe(true);
    expect(featureEnabled("usage", on)).toBe(false);
  });
});
