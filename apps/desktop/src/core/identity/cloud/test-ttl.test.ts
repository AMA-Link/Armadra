import { describe, expect, it } from "vitest";

import { MIN_BOUNDED_SESSION_TTL_MS, SAAS_SESSION_TTL_MS } from "../service";
import { TEST_SAAS_SESSION_TTL_ENV, testSaasSessionTtl } from "./test-ttl";

const env = (raw: string) => ({ [TEST_SAAS_SESSION_TTL_ENV]: raw });

describe("测试用的 SaaS 会话寿命（Q9，契约 §88.3）", () => {
  it("只有服务器壳认；没设是缺省", () => {
    expect(testSaasSessionTtl("server", env("300000"))).toBe(300_000);
    expect(testSaasSessionTtl("desktop", env("300000"))).toBeUndefined();
    expect(testSaasSessionTtl(undefined, env("1"))).toBeUndefined();
    expect(testSaasSessionTtl("server", {})).toBeUndefined();
    expect(testSaasSessionTtl("server", env(" "))).toBeUndefined();
  });

  it("两端都收：5 分钟与一小时", () => {
    expect(
      testSaasSessionTtl("server", env(String(MIN_BOUNDED_SESSION_TTL_MS))),
    ).toBe(MIN_BOUNDED_SESSION_TTL_MS);
    expect(testSaasSessionTtl("server", env(String(SAAS_SESSION_TTL_MS)))).toBe(
      SAAS_SESSION_TTL_MS,
    );
  });

  it("短于 5 分钟、长于一小时或不是整数：拒绝启动", () => {
    for (const raw of [
      "60000",
      String(MIN_BOUNDED_SESSION_TTL_MS - 1),
      String(SAAS_SESSION_TTL_MS + 1),
      "86400000",
      "abc",
      "-5",
      "1e6",
      "3.5",
      "0",
    ])
      expect(() => testSaasSessionTtl("server", env(raw)), raw).toThrow(
        TEST_SAAS_SESSION_TTL_ENV,
      );
  });
});
