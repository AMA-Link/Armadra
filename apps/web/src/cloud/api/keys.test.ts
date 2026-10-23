import { describe, expect, it } from "vitest";

import { cloudKeys, invalidationsFor, spaceKey } from "./keys";

const hit = (
  event: Parameters<typeof invalidationsFor>[0],
  key: readonly unknown[],
) => invalidationsFor(event).some((match) => match(key));

describe("查询键", () => {
  it("全部以 cloud 开头，空间键是 me 或 t:<teamId>", () => {
    expect(spaceKey()).toBe("me");
    expect(spaceKey("t1")).toBe("t:t1");
    const keys = [
      cloudKeys.me,
      cloudKeys.spaces,
      cloudKeys.devices,
      cloudKeys.securityLog(),
      cloudKeys.hosts("me", { status: "online" }),
      cloudKeys.host("t:t1", "h1"),
      cloudKeys.audit("t:t1", { action: "x" }, "c"),
      cloudKeys.ops("tenants"),
    ];
    for (const key of keys) expect(key[0]).toBe("cloud");
    expect(cloudKeys.hosts("me", { status: "online" })).toEqual([
      "cloud",
      "me",
      "hosts",
      { status: "online" },
    ]);
  });

  it("me-stream 事件只失效对应的键", () => {
    const at = { atMs: 1 };
    expect(
      hit(
        { type: "memberChanged", teamId: "t1", change: "added", ...at },
        cloudKeys.members("t:t1"),
      ),
    ).toBe(true);
    expect(
      hit(
        { type: "memberChanged", teamId: "t1", change: "added", ...at },
        cloudKeys.members("t:t2"),
      ),
    ).toBe(false);
    expect(
      hit(
        { type: "memberChanged", teamId: "t1", change: "added", ...at },
        cloudKeys.spaces,
      ),
    ).toBe(true);
    expect(
      hit(
        { type: "grantChanged", sourceId: "s1", teamId: "t1", ...at },
        cloudKeys.access("t:t1", "s1"),
      ),
    ).toBe(true);
    expect(
      hit(
        { type: "grantChanged", sourceId: "s1", teamId: "t1", ...at },
        cloudKeys.access("t:t1", "s2"),
      ),
    ).toBe(false);
    // 没有 teamId = 个人空间。
    expect(
      hit(
        { type: "linkUsed", linkId: "l", by: {}, ...at },
        cloudKeys.links("me"),
      ),
    ).toBe(true);
    expect(
      hit(
        { type: "linkUsed", linkId: "l", by: {}, ...at },
        cloudKeys.links("t:t1"),
      ),
    ).toBe(false);
    // 撤销类不报空间：全部空间。
    expect(
      hit(
        { type: "accessRevoked", sourceId: "s1" },
        cloudKeys.access("t:t9", "s1"),
      ),
    ).toBe(true);
    expect(
      hit(
        {
          type: "deviceTrustResolved",
          requestId: "r",
          outcome: "trusted",
          ...at,
        },
        cloudKeys.trust("t:t9"),
      ),
    ).toBe(true);
    expect(
      hit(
        {
          type: "planChanged",
          space: { kind: "team", teamId: "t1" },
          plan: "team",
          status: "active",
          ...at,
        },
        cloudKeys.usage("t:t1"),
      ),
    ).toBe(true);
    // 我收到的邀请与待信任请求在个人空间的键下，团队事件也要让它们过期。
    expect(
      hit(
        {
          type: "invitationChanged",
          invitationId: "i",
          teamId: "t1",
          state: "accepted",
          ...at,
        },
        cloudKeys.invitations("me"),
      ),
    ).toBe(true);
    expect(
      hit(
        {
          type: "deviceTrustRequested",
          requestId: "r",
          sourceId: "s",
          teamId: "t1",
          ...at,
        },
        cloudKeys.trust("me"),
      ),
    ).toBe(true);
    // 上下线是就地改缓存，不重拉。
    expect(
      invalidationsFor({
        type: "sourceOnline",
        sourceId: "s",
        sinceMs: 1,
        relayOrigin: "",
      }),
    ).toEqual([]);
    expect(invalidationsFor({ type: "ping", ts: 1 })).toEqual([]);
  });
});
