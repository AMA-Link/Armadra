import { describe, expect, it } from "vitest";

import {
  type ConnectPayload,
  connectUrl,
  encodeConnectFragment,
  parseConnect,
} from "./connect-link.js";

const TICKET = `${"a1".repeat(16)}.${"Qz3".repeat(14)}_-`;
const NOW = 1_800_000_000_000;

const direct = {
  origins: ["https://192.168.1.20:8443", "https://mac.local:8443"],
  ticket: TICKET,
  fingerprint: "ab".repeat(32),
};
const relay = {
  identityPub: "A".repeat(43),
  secret: "B".repeat(22),
  issuers: ["https://app.armadra.com"],
};
const both: ConnectPayload = {
  sourceId: "0123456789abcdef0123456789abcdef",
  expiresAtMs: NOW + 120_000,
  direct,
  relay,
};

describe("连接二维码载荷 v2", () => {
  it("两半都在：往返不变，文本是网页链接", () => {
    const text = connectUrl("https://192.168.1.20:8443", both);
    expect(text.startsWith("https://192.168.1.20:8443/#c=2&s=")).toBe(true);
    const parsed = parseConnect(text, NOW);
    expect(parsed).toEqual({
      ok: true,
      payload: both,
      webOrigin: "https://192.168.1.20:8443",
    });
  });

  it("只有直连半或只有中转半", () => {
    for (const payload of [
      { ...both, relay: null },
      { ...both, direct: null },
    ]) {
      const parsed = parseConnect(
        connectUrl("https://app.armadra.com", payload),
      );
      expect(parsed.ok && parsed.payload).toEqual(payload);
    }
  });

  it("片段不会被编码两次：指纹是 43 字符，签发方逐个百分号编码", () => {
    const fragment = encodeConnectFragment(both);
    expect(fragment).toContain("&i=https%3A%2F%2Fapp.armadra.com");
    expect(/&f=[A-Za-z0-9_-]{43}(&|$)/.test(fragment)).toBe(true);
  });

  it("边界：3 个来源 + 2 个签发方、IPv6、默认端口", () => {
    const wide: ConnectPayload = {
      ...both,
      direct: {
        ...direct,
        origins: [
          "https://192.168.100.100:65535",
          "https://[fd00::1]:8443",
          "https://host.example.com",
        ],
      },
      relay: {
        ...relay,
        issuers: ["https://app.armadra.com", "http://127.0.0.1:8787"],
      },
    };
    const parsed = parseConnect(
      connectUrl("https://192.168.100.100:65535", wide),
    );
    expect(parsed.ok && parsed.payload.direct?.origins).toEqual([
      "https://192.168.100.100:65535",
      "https://[fd00::1]:8443",
      "https://host.example.com:443",
    ]);
    // 最大载荷要装得进 QR 版本 15·M（412 字节）。
    expect(
      connectUrl("https://192.168.100.100:65535", wide).length,
    ).toBeLessThanOrEqual(412);
  });

  it("编码拒绝不合规矩的载荷", () => {
    expect(() =>
      encodeConnectFragment({ ...both, direct: null, relay: null }),
    ).toThrow();
    expect(() =>
      encodeConnectFragment({ ...both, direct: { ...direct, origins: [] } }),
    ).toThrow();
    expect(() =>
      encodeConnectFragment({
        ...both,
        direct: { ...direct, origins: Array(4).fill("https://10.0.0.1:1") },
      }),
    ).toThrow();
    expect(() =>
      encodeConnectFragment({
        ...both,
        relay: {
          ...relay,
          issuers: ["a", "b", "c"].map((x) => `https://${x}.com`),
        },
      }),
    ).toThrow();
    expect(() => encodeConnectFragment({ ...both, sourceId: "x" })).toThrow();
  });

  it("缺键、多键、重复键、长度不对一律 invalid", () => {
    const base = encodeConnectFragment(both);
    const bad = (fragment: string) =>
      expect(parseConnect(`https://x.example.com/#${fragment}`)).toEqual({
        ok: false,
        reason: "invalid",
      });
    bad(base.replace(/&t=[^&]*/, ""));
    bad(base.replace(/&k=[^&]*/, ""));
    bad(`${base}&z=1`);
    bad(`${base}&s=${both.sourceId}`);
    bad(base.replace(/&p=[^&]*/, `&p=${"B".repeat(21)}`));
    bad(base.replace(/&f=[^&]*/, `&f=${"B".repeat(42)}`));
    bad(base.replace(/&s=[^&]*/, "&s=zz"));
    bad(base.replace(/&e=[^&]*/, "&e=abc"));
    bad(base.replace(/&o=[^&]*/, "&o=192.168.1.1"));
    bad(base.replace(/&i=[^&]*/, "&i=ftp%3A%2F%2Fx.com"));
    bad(`c=2&s=${both.sourceId}&e=${NOW}`);
    expect(parseConnect("https://x.example.com/#pair=abc")).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(parseConnect("not a url")).toEqual({ ok: false, reason: "invalid" });
    expect(parseConnect("https://x.example.com/a#c=2")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("older / newer / expired", () => {
    const fragment = encodeConnectFragment(both);
    expect(parseConnect("armadra://pair?host=1.2.3.4:5&ticket=a&fp=b")).toEqual(
      {
        ok: false,
        reason: "older",
      },
    );
    expect(parseConnect("armadra://pair-e2e?d=xyz")).toEqual({
      ok: false,
      reason: "older",
    });
    expect(
      parseConnect(`https://x.example.com/#${fragment.replace("c=2", "c=1")}`),
    ).toEqual({ ok: false, reason: "older" });
    expect(
      parseConnect(`https://x.example.com/#${fragment.replace("c=2", "c=3")}`),
    ).toEqual({ ok: false, reason: "newer" });
    const text = connectUrl("https://x.example.com", both);
    expect(parseConnect(text, both.expiresAtMs + 59_000).ok).toBe(true);
    expect(parseConnect(text, both.expiresAtMs + 60_000)).toEqual({
      ok: false,
      reason: "expired",
    });
  });
});
