import { describe, expect, it } from "vitest";

import { CloudLogin } from "./login";
import { TEST_SAAS_SESSION_TTL_ENV, testSaasSessionTtl } from "./test-ttl";

describe("测试用的 SaaS 会话寿命（Q9）", () => {
  it("只有服务器壳认，只认正整数毫秒", () => {
    const env = { [TEST_SAAS_SESSION_TTL_ENV]: "300000" };
    expect(testSaasSessionTtl("server", env)).toBe(300_000);
    expect(testSaasSessionTtl("desktop", env)).toBeUndefined();
    for (const raw of ["", "abc", "-5", "1e6", "0", "3.5"])
      expect(
        testSaasSessionTtl("server", { [TEST_SAAS_SESSION_TTL_ENV]: raw }),
      ).toBeUndefined();
    expect(testSaasSessionTtl("server", {})).toBeUndefined();
  });

  it("短于 5 分钟由 CloudLogin 拒绝", () => {
    const ttl = testSaasSessionTtl("server", {
      [TEST_SAAS_SESSION_TTL_ENV]: "60000",
    });
    expect(() => new CloudLogin({ saasSessionTtlMs: ttl } as never)).toThrow();
  });
});
