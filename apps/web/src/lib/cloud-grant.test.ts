import { describe, expect, it } from "vitest";

import {
  composeAccess,
  composeRole,
  lowersEffectiveRole,
  narrowed,
  narrowsAccess,
  narrowsScope,
  shortensExpiry,
  updateNarrows,
} from "./cloud-grant";

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

describe("合成的范围与到期", () => {
  it("整台：角色取整台来路里最高的，到期取恰为该角色的整台来路", () => {
    const composed = composeAccess([
      { role: "driver", workspaceIds: ["w1"], expiresAtMs: 100 },
      { role: "viewer", workspaceIds: [], expiresAtMs: 900 },
      { role: "editor", workspaceIds: [], expiresAtMs: 500 },
    ]);
    expect(composed).toEqual({
      role: "editor",
      whole: true,
      workspaceIds: [],
      expiresAtMs: 500,
    });
  });

  it("限工作空间：范围并集升序去重，到期取角色不低于合成角色的来路", () => {
    const composed = composeAccess([
      { role: "driver", workspaceIds: ["w2"], expiresAtMs: 300 },
      { role: "editor", workspaceIds: ["w1", "w2"], expiresAtMs: 200 },
    ]);
    expect(composed).toEqual({
      role: "editor",
      whole: false,
      workspaceIds: ["w1", "w2"],
      expiresAtMs: 200,
    });
  });
});

describe("收窄（云端撤令牌的条件）", () => {
  const driverW1 = composeAccess([{ role: "driver", workspaceIds: ["w1"] }]);

  it("角色降低、整台变部分、丢工作空间、到期提前都算收窄；放宽不算", () => {
    expect(
      narrowed(driverW1, composeAccess([{ role: "viewer", workspaceIds: [] }])),
    ).toBe(true);
    expect(
      narrowed(composeAccess([{ role: "driver", workspaceIds: [] }]), driverW1),
    ).toBe(true);
    expect(
      narrowed(
        composeAccess([{ role: "driver", workspaceIds: ["w1", "w2"] }]),
        driverW1,
      ),
    ).toBe(true);
    expect(
      narrowed(
        composeAccess([{ role: "driver", workspaceIds: ["w1"] }]),
        composeAccess([
          { role: "driver", workspaceIds: ["w1"], expiresAtMs: 5 },
        ]),
      ),
    ).toBe(true);
    expect(
      narrowed(driverW1, composeAccess([{ role: "driver", workspaceIds: [] }])),
    ).toBe(false);
    expect(narrowed(composeAccess([]), driverW1)).toBe(false);
  });

  it("新增更宽更低的团队授予会收窄成员原有的更高角色（合成降级）", () => {
    const own = { role: "driver", workspaceIds: ["w1"] } as const;
    const team = { role: "viewer", workspaceIds: [] } as const;
    expect(narrowsAccess([own], [own, team], NOW)).toBe(true);
    expect(composeRole([own, team])).toBe("viewer");
    // 已过期的来路不参与。
    expect(
      narrowsAccess(
        [{ ...own, expiresAtMs: 1 }],
        [{ ...own, expiresAtMs: 1 }, team],
        NOW,
      ),
    ).toBe(false);
  });
});

describe("改一条授予", () => {
  const held = { role: "editor", workspaceIds: [], expiresAtMs: null } as const;

  it("范围、到期的比较", () => {
    expect(narrowsScope([], ["w1"])).toBe(true);
    expect(narrowsScope(["w1"], [])).toBe(false);
    expect(narrowsScope(["w1", "w2"], ["w1"])).toBe(true);
    expect(narrowsScope(["w1"], ["w1", "w2"])).toBe(false);
    expect(shortensExpiry(null, 5)).toBe(true);
    expect(shortensExpiry(10, 5)).toBe(true);
    expect(shortensExpiry(5, 10)).toBe(false);
    expect(shortensExpiry(5, null)).toBe(false);
    expect(shortensExpiry(5, undefined)).toBe(false);
  });

  it("降角色、缩范围、缩短到期要确认；升角色、放宽、不改不用", () => {
    const edit = (next: object) =>
      updateNarrows(
        [held],
        held,
        { role: "editor", workspaceIds: [], ...next },
        NOW,
      );
    expect(edit({ role: "viewer" })).toBe(true);
    expect(edit({ workspaceIds: ["w1"] })).toBe(true);
    expect(edit({ expiresAtMs: 5_000 })).toBe(true);
    expect(edit({ role: "driver" })).toBe(false);
    expect(edit({})).toBe(false);
  });

  it("别的来路兜住的降低不提示：团队 driver 整台 + 本人 operator 整台，本人改 viewer", () => {
    const team = {
      role: "driver",
      workspaceIds: [],
      expiresAtMs: null,
    } as const;
    const own = {
      role: "operator",
      workspaceIds: [],
      expiresAtMs: null,
    } as const;
    expect(
      updateNarrows(
        [team, own],
        own,
        { role: "viewer", workspaceIds: [] },
        NOW,
      ),
    ).toBe(false);
    // 没有兜底来路时同样的改动要提示。
    expect(
      updateNarrows([own], own, { role: "viewer", workspaceIds: [] }, NOW),
    ).toBe(true);
  });
});
