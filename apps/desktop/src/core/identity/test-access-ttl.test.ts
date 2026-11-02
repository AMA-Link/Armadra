import { describe, expect, it } from "vitest";

import { ACCESS_TTL_MS } from "./service";
import {
  MIN_TEST_ACCESS_TTL_MS,
  TEST_ACCESS_TTL_ENV,
  testAccessTtl,
} from "./test-access-ttl";

const env = (raw: string) => ({ [TEST_ACCESS_TTL_ENV]: raw });

describe("测试用的访问密钥寿命（#706）", () => {
  it("没设是缺省", () => {
    expect(testAccessTtl({})).toBeUndefined();
    expect(testAccessTtl(env(" "))).toBeUndefined();
    expect(testAccessTtl(env("180000"))).toBe(180_000);
  });

  it("两端都收：1 分钟与 15 分钟", () => {
    expect(testAccessTtl(env(String(MIN_TEST_ACCESS_TTL_MS)))).toBe(
      MIN_TEST_ACCESS_TTL_MS,
    );
    expect(testAccessTtl(env(String(ACCESS_TTL_MS)))).toBe(ACCESS_TTL_MS);
  });

  it("短于 1 分钟、长于 15 分钟或不是整数：拒绝启动", () => {
    for (const raw of [
      "59999",
      String(ACCESS_TTL_MS + 1),
      "86400000",
      "abc",
      "-5",
      "1e6",
      "3.5",
      "0",
    ])
      expect(() => testAccessTtl(env(raw)), raw).toThrow(TEST_ACCESS_TTL_ENV);
  });
});
