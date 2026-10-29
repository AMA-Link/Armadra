import { describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => [] as { path: string; init?: RequestInit }[]);
vi.mock("../../api/request", async (original) => ({
  ...(await original<typeof import("../../api/request")>()),
  request: vi.fn(async (path: string, _schema: unknown, init?: RequestInit) => {
    sent.push({ path, ...(init === undefined ? {} : { init }) });
    return { publicKey: "AAAA", signature: "BBBB" };
  }),
}));

import { desktopDeviceKey } from "./device-key";

describe("本机设备钥签名（契约 §78.3）", () => {
  it("经 request 发：服务器壳页面的 Cookie 会话由它补 CSRF", async () => {
    await desktopDeviceKey();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.path).toBe("/api/e2e/sign");
    expect(sent[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(sent[0]!.init?.body))).toHaveProperty(
      "transcript",
    );
  });
});
