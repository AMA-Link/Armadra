import { describe, expect, it } from "vitest";

import { RelayExchanges, olderThan } from "./relay-login";
import type { NativeCredentials } from "./source-client";

const credentials = (token: string): NativeCredentials => ({
  hostId: "h",
  deviceId: "d",
  accessToken: token,
  refreshToken: `r-${token}`,
  accessExpiresAtMs: 10_000_000,
  principalHint: "",
});

describe("经中继换票的合并（契约 §88.2）", () => {
  const KEY = "source h https://relay";

  it("重登只共用自己到来之后才开始的那次；之前就开始的（旧断言）不共用", () => {
    const memo = new RelayExchanges();
    // A 的重登先开始，B 在 A 进行中到来。
    const a = memo.arrival(KEY);
    const aBegan = memo.begin(KEY);
    const b = memo.arrival(KEY);
    memo.record(KEY, true, aBegan, credentials("A"));
    expect(memo.shared(KEY, a, true, 0)?.accessToken).toBe("A");
    expect(memo.shared(KEY, b, true, 0)).toBeUndefined();
    // B 自己换；C 在 B 开始之前到来，可以共用 B 的。
    const c = memo.arrival(KEY);
    const bBegan = memo.begin(KEY);
    memo.record(KEY, true, bBegan, credentials("B"));
    expect(memo.shared(KEY, c, true, 0)?.accessToken).toBe("B");
  });

  it("普通换票共用到来之后完成的任何一次；重登不共用刷新换来的；不新鲜的不共用", () => {
    const memo = new RelayExchanges();
    const a = memo.arrival(KEY);
    const b = memo.arrival(KEY);
    memo.record(KEY, false, memo.begin(KEY), credentials("A"));
    expect(memo.shared(KEY, b, false, 0)?.accessToken).toBe("A");
    expect(memo.shared(KEY, b, true, 0)).toBeUndefined();
    expect(memo.shared(KEY, a, false, 10_000_000)).toBeUndefined();
    // 自己到来之前就完成的不算。
    expect(memo.shared(KEY, memo.arrival(KEY), false, 0)).toBeUndefined();
  });
});

describe("版本比较", () => {
  it("x.y.z 逐段比，认不出答 false", () => {
    expect(olderThan("0.9.4", "0.10.0")).toBe(true);
    expect(olderThan("0.10.0", "0.10.0")).toBe(false);
    expect(olderThan("1.0.0-beta", "0.11.0")).toBe(false);
    expect(olderThan("", "0.10.0")).toBe(false);
  });
});
