import { describe, expect, it } from "vitest";

import {
  PAIRING_PAKE_SID_BYTES,
  fromBase64Url,
  newPakeSid,
  normalizePairingCodeInput,
  pairingPakeFinishSchema,
  pairingPakeOffersSchema,
  pairingPakeStartSchema,
  pakeConfirm,
  pakeConfirmEquals,
  pakeGeneratorBytes,
  pakeKey,
  pakeShare,
  toBase64Url,
} from "./pairing-pake";

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const ORIGIN = "https://192.168.1.5:8443";
const ANCHOR = "a".repeat(64);
const OTHER_ANCHOR = "b".repeat(64);

/** App（initiator）与 Gateway（responder）各跑一遍，答两边的 ISK。 */
function run(appCode: string, gatewayCode: string) {
  const sid = newPakeSid();
  const app = pakeShare(appCode, sid);
  const gateway = pakeShare(gatewayCode, sid);
  const common = { sid, initiator: app.share, responder: gateway.share };
  return {
    app: pakeKey({ ...common, secret: app.secret, peer: gateway.share }),
    gateway: pakeKey({ ...common, secret: gateway.secret, peer: app.share }),
  };
}

describe("配对码 PAKE（契约 §73）", () => {
  it("同一枚码两边得到同一个会话密钥；大小写与连字符不算", () => {
    const { app, gateway } = run("abcd-2345", "ABCD2345");
    expect(app).not.toBeNull();
    expect(hex(app!)).toBe(hex(gateway!));
  });

  it("码不同密钥不同", () => {
    const { app, gateway } = run("ABCD2345", "ABCD2346");
    expect(hex(app!)).not.toBe(hex(gateway!));
  });

  it("确认标签绑来源与信任锚：中间人换了证书就对不上", () => {
    const { app, gateway } = run("ABCD2345", "ABCD2345");
    const server = pakeConfirm(gateway!, "server", ORIGIN, ANCHOR);
    expect(
      pakeConfirmEquals(server, pakeConfirm(app!, "server", ORIGIN, ANCHOR)),
    ).toBe(true);
    // 指纹按小写十六进制、去冒号比。
    const colons = ANCHOR.toUpperCase().replace(/(..)(?!$)/g, "$1:");
    expect(
      pakeConfirmEquals(server, pakeConfirm(app!, "server", ORIGIN, colons)),
    ).toBe(true);
    expect(
      pakeConfirmEquals(
        server,
        pakeConfirm(app!, "server", ORIGIN, OTHER_ANCHOR),
      ),
    ).toBe(false);
    expect(
      pakeConfirmEquals(
        server,
        pakeConfirm(app!, "server", "https://192.168.1.6:8443", ANCHOR),
      ),
    ).toBe(false);
    // 角色不同标签不同：一方的标签不能被反射回去冒充另一方。
    expect(
      pakeConfirmEquals(
        server,
        pakeConfirm(gateway!, "client", ORIGIN, ANCHOR),
      ),
    ).toBe(false);
  });

  it("对方的元素不合法或是单位元：答 null", () => {
    const sid = newPakeSid();
    const mine = pakeShare("ABCD2345", sid);
    const base = { secret: mine.secret, sid, initiator: mine.share };
    expect(
      pakeKey({
        ...base,
        peer: new Uint8Array(32),
        responder: new Uint8Array(32),
      }),
    ).toBeNull();
    expect(
      pakeKey({
        ...base,
        peer: new Uint8Array(32).fill(0xff),
        responder: new Uint8Array(32),
      }),
    ).toBeNull();
    expect(
      pakeKey({
        ...base,
        peer: new Uint8Array(31),
        responder: new Uint8Array(31),
      }),
    ).toBeNull();
  });

  it("每次的份额都不同（随机标量）", () => {
    const sid = newPakeSid();
    expect(hex(pakeShare("ABCD2345", sid).share)).not.toBe(
      hex(pakeShare("ABCD2345", sid).share),
    );
    expect(newPakeSid()).toHaveLength(PAIRING_PAKE_SID_BYTES);
  });

  /** 格式（域分隔串、拼接方式、哈希到群）改了这两条就变：两端必须同时升级。 */
  it("测试向量", () => {
    const sid = Uint8Array.from({ length: 16 }, (_, index) => index);
    expect(hex(pakeGeneratorBytes("ABCD2345", sid))).toBe(
      "9ab29964845f7b17c8b4511123d53bf771c1a386f5acf46a94579b9d743cba5b",
    );
    expect(
      hex(pakeConfirm(new Uint8Array(64).fill(7), "server", ORIGIN, "AB:cd")),
    ).toBe("90ac7249caf4991aa6922776e82048299ae8289a0c0c04decffe0e846e65a9a2");
  });

  it("base64url 只认规范拼法与给定长度", () => {
    const bytes = Uint8Array.from([0xfb, 0xff, 0x00, 0x10]);
    const text = toBase64Url(bytes);
    expect(text).toBe("-_8AEA");
    expect(hex(fromBase64Url(text, 4)!)).toBe(hex(bytes));
    expect(fromBase64Url(text, 5)).toBeNull();
    expect(fromBase64Url("-_8AEA==")).toBeNull();
    expect(fromBase64Url("-_8AEB")).toBeNull();
    expect(fromBase64Url("+/8AEA")).toBeNull();
  });

  it("线上形状", () => {
    const sid = toBase64Url(new Uint8Array(16));
    const share = toBase64Url(pakeShare("ABCD2345", new Uint8Array(16)).share);
    expect(pairingPakeStartSchema.safeParse({ sid, share }).success).toBe(true);
    expect(
      pairingPakeStartSchema.safeParse({ sid, share, code: "x" }).success,
    ).toBe(false);
    expect(
      pairingPakeStartSchema.safeParse({ sid: share, share }).success,
    ).toBe(false);
    const session = toBase64Url(new Uint8Array(16));
    const confirm = toBase64Url(new Uint8Array(32));
    expect(
      pairingPakeOffersSchema.safeParse({
        session,
        offers: Array.from({ length: 33 }, () => ({ share, confirm })),
      }).success,
    ).toBe(false);
    expect(
      pairingPakeFinishSchema.safeParse({ session, index: 0, confirm }).success,
    ).toBe(true);
    expect(
      pairingPakeFinishSchema.safeParse({ session, index: 32, confirm })
        .success,
    ).toBe(false);
    expect(normalizePairingCodeInput(" abcd-2345 ")).toBe("ABCD2345");
  });
});
