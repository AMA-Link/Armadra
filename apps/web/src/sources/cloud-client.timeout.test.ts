import { describe, expect, it } from "vitest";

import { CloudTransportError, cloudPlatformInfo } from "./cloud-client";

/**
 * 对端答了头、正文迟迟不来（#580 审查 P2-4）：超时要管到正文读完，否则入口
 * 在挂载前一直等，页面就停在空白上。
 */
describe("cloud-client 的超时", () => {
  it("正文读不完时也按超时中止，答传输错误", async () => {
    const fetch = (async (_url: string, init?: RequestInit) =>
      ({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_, reject) =>
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            ),
          ),
      }) as unknown as Response) as typeof globalThis.fetch;
    const started = Date.now();
    const error = await cloudPlatformInfo("https://app.test", {
      timeoutMs: 30,
      fetch,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudTransportError);
    expect(
      ((error as CloudTransportError).cause as { name?: string }).name,
    ).toBe("AbortError");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("正文按时读完：照常解析，不受超时影响", async () => {
    const fetch = (async () =>
      new Response(
        JSON.stringify({
          mode: "saas",
          issuer: "https://app.test",
          capabilities: [],
          webApp: "https://app.test",
        }),
      )) as typeof globalThis.fetch;
    await expect(
      cloudPlatformInfo("https://app.test", { timeoutMs: 30, fetch }),
    ).resolves.toMatchObject({ mode: "saas" });
  });
});
