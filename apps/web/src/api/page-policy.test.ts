import { afterEach, describe, expect, it, vi } from "vitest";

import {
  pagePolicyGrew,
  rememberPagePolicy,
  resetPagePolicy,
} from "./page-policy";

const answer = (connect: string) =>
  new Response(null, {
    headers: {
      "content-security-policy": `default-src 'self'; connect-src ${connect}; img-src 'self'`,
    },
  });

afterEach(() => resetPagePolicy());

describe("服务器壳页面的 CSP 跟着源表走（契约 §88.1）", () => {
  it("源表多出来源：要重载；没多（或少了）不重载", async () => {
    const fetcher = vi.fn(async () => answer("'self' https://app.example"));
    rememberPagePolicy(fetcher);
    expect(await pagePolicyGrew(fetcher)).toBe(false);
    fetcher.mockImplementation(async () => answer("'self'"));
    expect(await pagePolicyGrew(fetcher)).toBe(false);
    fetcher.mockImplementation(async () =>
      answer(
        "'self' https://app.example https://h.src.example wss://h.src.example",
      ),
    );
    expect(await pagePolicyGrew(fetcher)).toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      "/",
      expect.objectContaining({ method: "HEAD" }),
    );
  });

  it("启动时没记下（不是服务器壳）或读不到：不重载", async () => {
    const fetcher = vi.fn(async () => answer("'self' https://x.example"));
    expect(await pagePolicyGrew(fetcher)).toBe(false);
    rememberPagePolicy(async () => {
      throw new TypeError("offline");
    });
    expect(await pagePolicyGrew(fetcher)).toBe(false);
  });
});
