import { describe, expect, it } from "vitest";
import { pairingJson, pairingLinks } from "./pairing";

const FP = "ab".repeat(32);

describe("配对载荷", () => {
  it("网页链接把票与指纹放在片段里", () => {
    const links = pairingLinks("https://192.168.1.20:8443", "t.k", FP);
    expect(links.webUrl).toBe(`https://192.168.1.20:8443/#pair=t.k&fp=${FP}`);
  });

  it("线上形状：expiresAt 是 ISO 时间，没有别的字段", () => {
    const json = pairingJson({
      ticket: "t",
      expiresAtMs: Date.UTC(2026, 9, 3),
      origin: "https://127.0.0.1:8443",
      origins: ["https://127.0.0.1:8443"],
      fingerprint: FP,
      ...pairingLinks("https://127.0.0.1:8443", "t", FP),
    });
    expect(Object.keys(json).sort()).toEqual([
      "expiresAt",
      "fingerprint",
      "origin",
      "ticket",
      "webUrl",
    ]);
    expect(json.expiresAt).toBe("2026-10-03T00:00:00.000Z");
  });
});
