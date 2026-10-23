import { describe, expect, it } from "vitest";

import { composeRole, lowersEffectiveRole } from "./cloud-grant";

const NOW = 1_000;

describe("授予合成（cloud-api §24，#112）", () => {
  it("同范围取最高角色", () => {
    expect(
      composeRole([
        { role: "viewer", workspaceIds: ["w1"] },
        { role: "editor", workspaceIds: ["w1"] },
      ]),
    ).toBe("editor");
  });

  it("不放大：driver@w1 加 viewer 整台是 viewer", () => {
    expect(
      composeRole([
        { role: "driver", workspaceIds: ["w1"] },
        { role: "viewer", workspaceIds: [] },
      ]),
    ).toBe("viewer");
  });

  it("范围取并集：两个工作空间都要被角色覆盖", () => {
    expect(
      composeRole([
        { role: "driver", workspaceIds: ["w1"] },
        { role: "editor", workspaceIds: ["w2"] },
      ]),
    ).toBe("editor");
    expect(
      composeRole([
        { role: "driver", workspaceIds: ["w1", "w2"] },
        { role: "editor", workspaceIds: ["w2"] },
      ]),
    ).toBe("driver");
  });

  it("没有来路没有角色", () => {
    expect(composeRole([])).toBeNull();
  });
});

describe("新增授予是否降低有效角色", () => {
  it("更宽而更低：降低", () => {
    expect(
      lowersEffectiveRole(
        [{ role: "driver", workspaceIds: ["w1"] }],
        { role: "viewer", workspaceIds: [] },
        NOW,
      ),
    ).toBe(true);
  });

  it("同范围更低：不降低（取最高）", () => {
    expect(
      lowersEffectiveRole(
        [{ role: "editor", workspaceIds: ["w1"] }],
        { role: "viewer", workspaceIds: ["w1"] },
        NOW,
      ),
    ).toBe(false);
  });

  it("没有现有授予，或现有的已过期：不降低", () => {
    expect(
      lowersEffectiveRole([], { role: "viewer", workspaceIds: [] }, NOW),
    ).toBe(false);
    expect(
      lowersEffectiveRole(
        [{ role: "driver", workspaceIds: ["w1"], expiresAtMs: 500 }],
        { role: "viewer", workspaceIds: [] },
        NOW,
      ),
    ).toBe(false);
  });
});
