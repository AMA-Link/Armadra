import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ConnectPayload, connectUrl } from "@armadra/shared";

import { IdentityRequestError, IdentityTransportError } from "../api/identity";
import type { PairingOffer } from "../sources/e2e/pairing";
import {
  type OfferDeps,
  connectOffer,
  looksLikeConnect,
  readConnect,
} from "./connect-offer";
import { fakeBridge, memoryStorage } from "./testing";

const SOURCE = "0123456789abcdef0123456789abcdef";
const ANCHOR = "ab".repeat(32);
const A = "https://192.168.1.20:8443";
const B = "https://mac.local:8443";
const NOW = 1_800_000_000_000;

const direct = {
  origins: [A, B],
  ticket: `${"a1".repeat(16)}.${"Qz3".repeat(14)}_-`,
  fingerprint: ANCHOR,
};
const relayHalf = {
  identityPub: "A".repeat(43),
  secret: "B".repeat(22),
  issuers: ["https://app.armadra.com"],
};
const payload = (over: Partial<ConnectPayload> = {}): ConnectPayload => ({
  sourceId: SOURCE,
  expiresAtMs: NOW + 120_000,
  direct,
  relay: relayHalf,
  ...over,
});

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

function deps(
  over: {
    reachable?: string[];
    pair?: OfferDeps["pair"];
    pinFails?: string[];
    attach?: OfferDeps["attach"];
  } = {},
) {
  const pins: { origin: string; fingerprint: string }[] = [];
  const pin = vi.fn(async (origin: string, fingerprint: string) => {
    if (over.pinFails?.includes(origin)) throw new Error("pin");
    pins.push({ origin, fingerprint });
  });
  const { bridge } = fakeBridge({ pin });
  const probe = vi.fn(async (origin: string) =>
    (over.reachable ?? []).includes(origin),
  );
  const pair = vi.fn(over.pair ?? (async () => ({ hostId: SOURCE })));
  const remembered: PairingOffer[] = [];
  const record = vi.fn();
  const save = vi.fn();
  const reload = vi.fn();
  const value: OfferDeps = {
    native: {
      bridge,
      pair: pair as never,
      save,
      record,
      hostName: async () => "MacBook",
      reload,
    },
    probe,
    pair,
    remember: (offer) => remembered.push(offer),
    ...(over.attach === undefined ? {} : { attach: over.attach }),
    now: () => NOW,
    pairTimeoutMs: 50,
  };
  return { value, pin, probe, pair, remembered, record, save, reload };
}

describe("连接二维码 · 手机选路（契约 §99.5）", () => {
  it("第一个来源通：用它配对、记连接、重载；不碰中转", async () => {
    const d = deps({ reachable: [A, B] });
    await expect(connectOffer(payload(), undefined, d.value)).resolves.toEqual({
      kind: "done",
    });
    expect(d.pin).toHaveBeenCalledTimes(2);
    expect(d.pin).toHaveBeenCalledWith(A, ANCHOR);
    expect(d.pair).toHaveBeenCalledWith(A, direct.ticket);
    expect(d.record).toHaveBeenCalledWith({
      sourceId: SOURCE,
      origin: A,
      fingerprint: ANCHOR,
      hostName: "MacBook",
    });
    expect(d.save).toHaveBeenCalledWith(A);
    expect(d.reload).toHaveBeenCalledTimes(1);
  });

  it("只有第二个来源通：用第二个", async () => {
    const d = deps({ reachable: [B] });
    await connectOffer(payload(), undefined, d.value);
    expect(d.pair).toHaveBeenCalledWith(B, direct.ticket);
  });

  it("钉不上信任锚的来源按不通算，其余照常", async () => {
    const d = deps({ reachable: [A, B], pinFails: [A] });
    await connectOffer(payload(), undefined, d.value);
    expect(d.pair).toHaveBeenCalledWith(B, direct.ticket);
    expect(d.probe).not.toHaveBeenCalledWith(A, SOURCE);
  });

  it("全不通：记下 offer 转中转，带上源与签发方", async () => {
    const d = deps();
    await expect(connectOffer(payload(), undefined, d.value)).resolves.toEqual({
      kind: "relay",
      sourceId: SOURCE,
      issuers: ["https://app.armadra.com"],
    });
    expect(d.pair).not.toHaveBeenCalled();
    expect(d.remembered).toHaveLength(1);
    expect(d.remembered[0]).toMatchObject({
      sourceId: SOURCE,
      issuers: ["https://app.armadra.com"],
    });
    // 同时有直连半时，秘密比二维码截止多活 3 分钟。
    expect(d.remembered[0]?.expiresAtMs).toBe(NOW + 120_000 + 180_000);
    expect(d.reload).not.toHaveBeenCalled();
  });

  it("全不通又没有中转半：不可达", async () => {
    const d = deps();
    await expect(
      connectOffer(payload({ relay: null }), undefined, d.value),
    ).resolves.toEqual({ kind: "failure", failure: "offerUnreachable" });
    expect(d.remembered).toEqual([]);
  });

  it("只有中转半：不钉不探，直接转中转，秘密按二维码截止", async () => {
    const d = deps();
    await expect(
      connectOffer(payload({ direct: null }), undefined, d.value),
    ).resolves.toMatchObject({ kind: "relay" });
    expect(d.pin).not.toHaveBeenCalled();
    expect(d.remembered[0]?.expiresAtMs).toBe(NOW + 120_000);
  });

  it("配对答 401 / 410：报过期，不改走中转", async () => {
    for (const status of [401, 410]) {
      const d = deps({
        reachable: [A],
        pair: async () => {
          throw new IdentityRequestError(status, "unauthenticated", "x");
        },
      });
      await expect(
        connectOffer(payload(), undefined, d.value),
      ).resolves.toEqual({ kind: "failure", failure: "offerExpired" });
      expect(d.remembered).toEqual([]);
      expect(d.reload).not.toHaveBeenCalled();
    }
  });

  it("配对传输失败或超时：按不可达处理，转中转", async () => {
    const transport = deps({
      reachable: [A],
      pair: async () => {
        throw new IdentityTransportError("offline");
      },
    });
    await expect(
      connectOffer(payload(), undefined, transport.value),
    ).resolves.toMatchObject({ kind: "relay" });
    const slow = deps({
      reachable: [A],
      pair: () => new Promise(() => undefined),
    });
    await expect(
      connectOffer(payload(), undefined, slow.value),
    ).resolves.toMatchObject({ kind: "relay" });
  });

  it("过期的二维码在发任何请求之前拒绝", async () => {
    const d = deps({ reachable: [A] });
    await expect(
      connectOffer(payload({ expiresAtMs: NOW - 61_000 }), undefined, d.value),
    ).resolves.toEqual({ kind: "failure", failure: "offerExpired" });
    expect(d.pin).not.toHaveBeenCalled();
  });

  it("直连成功又有中转半：记下 offer，已登录时后台挂中转（quiet），失败不影响直连", async () => {
    const attach = vi.fn(async () => {
      throw new Error("boom");
    });
    const d = deps({ reachable: [A], attach: attach as never });
    await expect(connectOffer(payload(), undefined, d.value)).resolves.toEqual({
      kind: "done",
    });
    expect(d.remembered).toHaveLength(1);
    expect(attach).toHaveBeenCalledWith(
      { sourceId: SOURCE, issuers: ["https://app.armadra.com"] },
      { quiet: true },
    );
    expect(d.reload).toHaveBeenCalledTimes(1);
  });
});

describe("读二维码文本", () => {
  const text = connectUrl(A, payload());

  it("合规矩的读出载荷；旧版、新版、过期、不合规矩各有失败原因", () => {
    expect(readConnect(text, NOW)).toMatchObject({ ok: true });
    expect(readConnect("armadra://pair?host=x", NOW)).toEqual({
      ok: false,
      failure: "connectOlder",
    });
    expect(readConnect(text.replace("#c=2", "#c=3"), NOW)).toEqual({
      ok: false,
      failure: "connectNewer",
    });
    expect(readConnect(text, NOW + 10 * 60_000)).toEqual({
      ok: false,
      failure: "offerExpired",
    });
    expect(readConnect(`${A}/#c=2&s=zz`, NOW)).toEqual({
      ok: false,
      failure: "invalid",
    });
  });

  it("只有带 #c= 的才按连接二维码处理，其余形状走原来的解析", () => {
    expect(looksLikeConnect(text)).toBe(true);
    expect(looksLikeConnect(`${A}/#pair=abc`)).toBe(false);
    expect(looksLikeConnect("armadra://pair?host=x")).toBe(false);
    expect(looksLikeConnect("https://relay.example.com/j/abc#s.t")).toBe(false);
  });
});
