import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

import { fail } from "../../http/errors";
import type { CoreRequest } from "../../http/router";
import type { Authorizer } from "../authorize";
import type { IdentityService } from "../service";
import type { Throttle } from "../throttle";
import { CLOUD_PREFIX, CloudHttp } from "./http";
import type { CloudService } from "./service";

/**
 * `POST /api/identity/cloud/login` 对来源地址失败令牌桶的扣法（契约 §31.3、#484）：
 * `device_untrusted` 只是「设备不受信」、不算一次失败的登录，其余失败（含 `device_pending`）都扣——
 * 否则换设备钥可以无限刷待确认记录。
 */

async function loginWith(failure: unknown): Promise<{
  charged: string[];
  checked: string[];
}> {
  const charged: string[] = [];
  const checked: string[] = [];
  const throttle = {
    checkIp: (ip: string) => void checked.push(ip),
    chargeIp: (ip: string) => void charged.push(ip),
  } as unknown as Throttle;
  const http = new CloudHttp({
    service: { hostId: () => "host" } as unknown as IdentityService,
    authorizer: {} as Authorizer,
    cloud: {
      login: vi.fn().mockRejectedValue(failure),
    } as unknown as CloudService,
    throttle,
  });
  const body = Buffer.from(JSON.stringify({ assertion: "jws" }));
  const request = {
    method: "POST",
    path: `${CLOUD_PREFIX}/login`,
    headers: { origin: "http://127.0.0.1:1420" },
    body,
    json: () => JSON.parse(body.toString("utf8")) as unknown,
    raw: { socket: { remoteAddress: "::ffff:203.0.113.9" } },
  } as unknown as CoreRequest;
  const response = {
    setHeader: () => undefined,
    writeHead: () => undefined,
    end: () => undefined,
  } as unknown as ServerResponse;
  await http.handle(request, response, {});
  return { charged, checked };
}

describe("cloud/login 扣来源地址桶", () => {
  it("device_pending 扣", async () => {
    const result = await loginWith(fail("device_pending", "等待确认"));
    expect(result.checked).toEqual(["203.0.113.9"]);
    expect(result.charged).toEqual(["203.0.113.9"]);
  });

  it("device_untrusted 不扣", async () => {
    const result = await loginWith(fail("device_untrusted", "不受信"));
    expect(result.charged).toEqual([]);
  });

  it("其他失败扣", async () => {
    const result = await loginWith(fail("cloud_assertion_invalid", "无效"));
    expect(result.charged).toEqual(["203.0.113.9"]);
  });
});
