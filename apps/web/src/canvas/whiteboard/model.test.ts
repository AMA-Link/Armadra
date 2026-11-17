import { describe, expect, it } from "vitest";

import { fromItemId, isItemId, toItemId } from "./model";

const NODE = "11111111-1111-4111-8111-111111111111";

describe("id 判定", () => {
  it("`wb:` 前缀区分白板对象与 `nodes` 行", () => {
    expect(isItemId("wb:abc")).toBe(true);
    expect(isItemId(NODE)).toBe(false);
  });

  it("加前缀与去前缀是一对逆运算，重复调用幂等", () => {
    expect(toItemId("abc")).toBe("wb:abc");
    expect(toItemId("wb:abc")).toBe("wb:abc");
    expect(fromItemId("wb:abc")).toBe("abc");
    expect(fromItemId("abc")).toBe("abc");
  });
});
