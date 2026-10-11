import {
  type PairingPakeFinish,
  type PairingPakeStart,
  fromBase64Url,
  pakeConfirm,
  pakeConfirmEquals,
  pakeKey,
  pakeShare,
  toBase64Url,
} from "@armadra/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IdentityRequestError } from "../api/identity";
import { connectNativeWithCode } from "./connect";
import type { NativeBridge, PeekResult } from "./native-bridge";
import { runPairingPake } from "./pairing-pake";
import { memoryStorage } from "./testing";

/**
 * 原生 App 首次连接用配对码（契约 §73，#338）。替身 Gateway 用与 core 相同的
 * 原语答 start / finish（core 那一半的完整用例在 `gateway/pairing-pake.test.ts`
 * 与 `gateway.integration.test.ts`）。
 */

const ORIGIN = "https://192.168.1.8:8443";
const ANCHOR = "ab".repeat(32);
const FORGED = "cd".repeat(32);
const CODE = "3F7K9Q2M";

/** 一台 Gateway：活着的码、绑的来源与它自己的信任锚。 */
function gateway(codes: readonly string[] = [CODE], anchor = ANCHOR) {
  const sessions = new Map<string, { code: string; isk: Uint8Array }[]>();
  const finished: PairingPakeFinish[] = [];
  return {
    finished,
    start: vi.fn(async (_base: string, body: PairingPakeStart) => {
      const sid = fromBase64Url(body.sid, 16)!;
      const initiator = fromBase64Url(body.share, 32)!;
      const candidates = codes.map((code) => {
        const mine = pakeShare(code, sid);
        const isk = pakeKey({
          secret: mine.secret,
          peer: initiator,
          sid,
          initiator,
          responder: mine.share,
        })!;
        return { code, isk, share: mine.share };
      });
      const session = toBase64Url(new Uint8Array(16).fill(sessions.size + 1));
      sessions.set(session, candidates);
      return {
        session,
        offers: candidates.map((one) => ({
          share: toBase64Url(one.share),
          confirm: toBase64Url(pakeConfirm(one.isk, "server", ORIGIN, anchor)),
        })),
      };
    }),
    finish: vi.fn(async (_base: string, body: PairingPakeFinish) => {
      finished.push(body);
      const candidate = sessions.get(body.session)?.[body.index];
      sessions.delete(body.session);
      if (
        candidate === undefined ||
        !pakeConfirmEquals(
          pakeConfirm(candidate.isk, "client", ORIGIN, anchor),
          fromBase64Url(body.confirm, 32)!,
        )
      )
        throw new IdentityRequestError(404, "pairing_code_invalid", "");
      return {
        origin: ORIGIN,
        ticket: "tk.secret",
        fingerprint: anchor,
        expiresAt: "2026-10-12T08:02:00.000Z",
        webUrl: `${ORIGIN}/#pair=tk.secret&fp=${anchor}`,
        deepLink: `armadra://pair?host=192.168.1.8%3A8443&ticket=tk.secret&fp=${anchor}`,
      };
    }),
  };
}

function native(peek: PeekResult | null) {
  const bridge = {
    available: true,
    canScan: false,
    peek: vi.fn(async () => peek),
    pin: vi.fn(async () => undefined),
  } as unknown as NativeBridge;
  return {
    bridge,
    pair: vi.fn(async () => ({ hostId: "host-1" }) as never),
    save: vi.fn(),
    reload: vi.fn(),
    record: vi.fn(),
  };
}

const unpinned = (fingerprint = ANCHOR): PeekResult => ({
  fingerprint,
  trusted: false,
  pinned: false,
});

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

describe("原生 App 首次连接用配对码（契约 §73）", () => {
  it("暂钉取到的锚 → PAKE 换票 → 按载荷钉锚、配对、记连接、重载", async () => {
    const server = gateway(["AAAAAAAA", CODE, "BBBBBBBB"]);
    const app = native(unpinned());
    await expect(
      connectNativeWithCode("192.168.1.8:8443", "3f7k-9q2m", {
        native: app,
        start: server.start,
        finish: server.finish,
        recorded: () => null,
      }),
    ).resolves.toBeNull();
    expect(app.bridge.peek).toHaveBeenCalledWith(ORIGIN);
    // 第一次钉在 PAKE 之前（不然 TLS 都过不了），第二次按载荷再钉同一张。
    expect(app.bridge.pin).toHaveBeenNthCalledWith(1, ORIGIN, ANCHOR);
    expect(app.bridge.pin).toHaveBeenNthCalledWith(2, ORIGIN, ANCHOR);
    expect(server.finished).toHaveLength(1);
    expect(server.finished[0]?.index).toBe(1);
    expect(app.pair).toHaveBeenCalledWith(ORIGIN, "tk.secret");
    expect(app.record).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: "host-1", fingerprint: ANCHOR }),
    );
    expect(app.save).toHaveBeenCalledWith(ORIGIN);
    expect(app.reload).toHaveBeenCalled();
  });

  it("中间人换了证书：取到的锚不是 Gateway 的，标签对不上，不发 finish、不配对", async () => {
    const server = gateway();
    const app = native(unpinned(FORGED));
    await expect(
      connectNativeWithCode(ORIGIN, CODE, {
        native: app,
        start: server.start,
        finish: server.finish,
        recorded: () => null,
      }),
    ).resolves.toBe("codeMismatch");
    expect(server.finish).not.toHaveBeenCalled();
    expect(app.pair).not.toHaveBeenCalled();
    expect(app.save).not.toHaveBeenCalled();
  });

  it("码错：不发 finish", async () => {
    const server = gateway(["AAAAAAAA"]);
    const app = native(unpinned());
    await expect(
      connectNativeWithCode(ORIGIN, CODE, {
        native: app,
        start: server.start,
        finish: server.finish,
        recorded: () => null,
      }),
    ).resolves.toBe("codeMismatch");
    expect(server.finish).not.toHaveBeenCalled();
  });

  it("连接表里这个来源钉的是另一张：拒绝，不覆盖原有钉扎", async () => {
    const server = gateway();
    const app = native(unpinned(FORGED));
    await expect(
      connectNativeWithCode(ORIGIN, CODE, {
        native: app,
        start: server.start,
        finish: server.finish,
        recorded: () => ANCHOR.toUpperCase(),
      }),
    ).resolves.toBe("anchorChanged");
    expect(app.bridge.pin).not.toHaveBeenCalled();
    expect(server.start).not.toHaveBeenCalled();
  });

  it("已经钉过、服务端仍发着那张：照旧明文换码（§24）", async () => {
    const app = native({ fingerprint: ANCHOR, trusted: false, pinned: true });
    const exchange = vi.fn(async () => ({
      origin: ORIGIN,
      ticket: "tk.secret",
      fingerprint: ANCHOR,
      expiresAt: "2026-10-12T08:02:00.000Z",
      webUrl: `${ORIGIN}/#pair=tk.secret&fp=${ANCHOR}`,
      deepLink: "armadra://pair?host=x&ticket=tk.secret&fp=x",
    }));
    const server = gateway();
    await expect(
      connectNativeWithCode(ORIGIN, CODE, {
        native: app,
        exchange,
        start: server.start,
        finish: server.finish,
      }),
    ).resolves.toBeNull();
    expect(exchange).toHaveBeenCalledWith(CODE, ORIGIN);
    expect(server.start).not.toHaveBeenCalled();
  });

  it("地址不对、连不上、旧版 core、限流各有原因", async () => {
    const server = gateway();
    expect(
      await connectNativeWithCode("http://192.168.1.8:8443", CODE, {
        native: native(unpinned()),
      }),
    ).toBe("address");
    expect(
      await connectNativeWithCode("", CODE, { native: native(unpinned()) }),
    ).toBe("address");
    expect(
      await connectNativeWithCode(ORIGIN, CODE, {
        native: native(null),
        start: server.start,
      }),
    ).toBe("unreachable");
    expect(
      await connectNativeWithCode(ORIGIN, CODE, {
        native: native(unpinned()),
        recorded: () => null,
        start: async () => {
          throw new IdentityRequestError(404, "not_found", "");
        },
      }),
    ).toBe("codeUpgrade");
    expect(
      await connectNativeWithCode(ORIGIN, CODE, {
        native: native(unpinned()),
        recorded: () => null,
        start: async () => {
          throw new IdentityRequestError(429, "rate_limited", "", 30);
        },
      }),
    ).toBe("rateLimited");
  });
});

describe("runPairingPake", () => {
  it("冒充 Gateway 的一方给多于 32 个候选：只看前 32 个", async () => {
    const server = gateway();
    const many = vi.fn(async (body: PairingPakeStart) => {
      const real = await server.start("", body);
      const filler = real.offers[0]!;
      // 真的那个排在第 33 位：App 不看它。
      return {
        session: real.session,
        offers: [
          ...Array.from({ length: 32 }, () => ({
            share: toBase64Url(pakeShare("ZZZZZZZZ", new Uint8Array(16)).share),
            confirm: filler.confirm,
          })),
          filler,
        ],
      };
    });
    const outcome = await runPairingPake({
      code: CODE,
      origin: ORIGIN,
      fingerprint: ANCHOR,
      transport: {
        start: many,
        finish: (body) => server.finish("", body),
      },
    });
    expect(outcome.kind).toBe("mismatch");
    expect(server.finish).not.toHaveBeenCalled();
  });
});
