import {
  type PairingPakeOffers,
  fromBase64Url,
  newPakeSid,
  pakeConfirm,
  pakeConfirmEquals,
  pakeKey,
  pakeShare,
  toBase64Url,
} from "@armadra/shared";
import { describe, expect, it } from "vitest";

import type { PairingTicket } from "./pairing";
import { PairingCodes } from "./pairing-code";
import { PAKE_SESSION_TTL_MS, PairingPake } from "./pairing-pake";

const ORIGIN = "https://192.168.1.20:8443";
const ANCHOR = "f".repeat(64);
const FORGED = "e".repeat(64);

function ticket(expiresAtMs: number, suffix = "a"): PairingTicket {
  return {
    ticket: `${suffix.repeat(32)}.${"b".repeat(43)}`,
    expiresAtMs,
    origin: ORIGIN,
    fingerprint: ANCHOR,
    webUrl: `${ORIGIN}/#pair=x`,
    deepLink: "armadra://pair?host=x&ticket=x&fp=x",
  };
}

/**
 * App 那一半，与 `apps/web/src/mobile/pairing-pake.ts` 同一套核对：每个候选算
 * ISK，用自己看到的来源与指纹核对 Gateway 的标签，对上了才出客户端标签。
 */
function app(code: string, origin = ORIGIN, fingerprint = ANCHOR) {
  const sid = newPakeSid();
  const mine = pakeShare(code, sid);
  return {
    start: { sid: toBase64Url(sid), share: toBase64Url(mine.share) },
    answer(offers: PairingPakeOffers) {
      for (const [index, offer] of offers.offers.entries()) {
        const responder = fromBase64Url(offer.share, 32) as Uint8Array;
        const isk = pakeKey({
          secret: mine.secret,
          peer: responder,
          sid,
          initiator: mine.share,
          responder,
        });
        if (isk === null) continue;
        const expected = pakeConfirm(isk, "server", origin, fingerprint);
        if (
          pakeConfirmEquals(
            expected,
            fromBase64Url(offer.confirm, 32) as Uint8Array,
          )
        ) {
          return {
            session: offers.session,
            index,
            confirm: toBase64Url(
              pakeConfirm(isk, "client", origin, fingerprint),
            ),
          };
        }
      }
      return null;
    },
  };
}

function setup(now = { value: 1_000 }) {
  const codes = new PairingCodes(() => now.value);
  const pake = new PairingPake(codes, () => now.value);
  return { codes, pake, now };
}

function offersOf(result: ReturnType<PairingPake["start"]>): PairingPakeOffers {
  if (!result.ok) throw new Error(`start refused: ${result.reason}`);
  return result.body;
}

describe("配对码 PAKE：Gateway 这一半（契约 §73）", () => {
  it("码对、来源与指纹一致：App 认出候选，finish 取走短码答票", () => {
    const { codes, pake, now } = setup();
    const issued = ticket(now.value + 120_000);
    const code = codes.issue(issued);
    codes.issue(ticket(now.value + 120_000, "c"));
    const phone = app(code.toLowerCase());
    const offers = offersOf(
      pake.start({ ...phone.start, remoteIp: "10.0.0.2" }),
    );
    expect(offers.offers).toHaveLength(2);
    const finish = phone.answer(offers);
    expect(finish).not.toBeNull();
    expect(pake.finish(finish!)).toEqual({ ok: true, ticket: issued });
    // 取走了：明文兑换也不认了；另一枚还在。
    expect(codes.exchange(code, "10.0.0.2").ok).toBe(false);
    expect(codes.size).toBe(1);
  });

  it("码错：App 一个候选都对不上，不发 finish；硬发一个也不认", () => {
    const { codes, pake, now } = setup();
    const code = codes.issue(ticket(now.value + 120_000));
    const wrong = code.startsWith("A")
      ? `B${code.slice(1)}`
      : `A${code.slice(1)}`;
    const phone = app(wrong);
    const offers = offersOf(
      pake.start({ ...phone.start, remoteIp: "10.0.0.2" }),
    );
    expect(phone.answer(offers)).toBeNull();
    expect(
      pake.finish({
        session: offers.session,
        index: 0,
        confirm: toBase64Url(new Uint8Array(32)),
      }),
    ).toEqual({ ok: false, reason: "invalid" });
    // 短码没被取走：拿对的码重新来一遍仍可用。
    const again = app(code);
    const finish = again.answer(
      offersOf(pake.start({ ...again.start, remoteIp: "10.0.0.2" })),
    );
    expect(pake.finish(finish!).ok).toBe(true);
  });

  it("中间人换了证书：App 看到的指纹不同，Gateway 的标签对不上，不发 finish", () => {
    const { codes, pake, now } = setup();
    const code = codes.issue(ticket(now.value + 120_000));
    const phone = app(code, ORIGIN, FORGED);
    const offers = offersOf(
      pake.start({ ...phone.start, remoteIp: "10.0.0.2" }),
    );
    expect(phone.answer(offers)).toBeNull();
  });

  it("中间人照转、自己拿 App 的会话去 finish：客户端标签绑的是它看到的指纹，Gateway 不认", () => {
    const { codes, pake, now } = setup();
    const code = codes.issue(ticket(now.value + 120_000));
    // App 连着中间人（看到 FORGED），中间人把 start 原样转给真 Gateway。
    const sid = newPakeSid();
    const mine = pakeShare(code, sid);
    const offers = offersOf(
      pake.start({
        sid: toBase64Url(sid),
        share: toBase64Url(mine.share),
        remoteIp: "10.0.0.66",
      }),
    );
    // 中间人改不了 Gateway 的标签（要 ISK），App 按 FORGED 核对就停下；
    // 即使 App 被骗着出了标签，那也是按 FORGED 算的。
    const offer = offers.offers[0]!;
    const responder = fromBase64Url(offer.share, 32)!;
    const isk = pakeKey({
      secret: mine.secret,
      peer: responder,
      sid,
      initiator: mine.share,
      responder,
    })!;
    expect(
      pake.finish({
        session: offers.session,
        index: 0,
        confirm: toBase64Url(pakeConfirm(isk, "client", ORIGIN, FORGED)),
      }),
    ).toEqual({ ok: false, reason: "invalid" });
  });

  it("App 拨的来源与票绑定的不同：标签对不上", () => {
    const { codes, pake, now } = setup();
    const code = codes.issue(ticket(now.value + 120_000));
    const phone = app(code, "https://192.168.1.21:8443");
    const offers = offersOf(
      pake.start({ ...phone.start, remoteIp: "10.0.0.2" }),
    );
    expect(phone.answer(offers)).toBeNull();
  });

  it("会话一次性：finish 过一次（对或错）就没了", () => {
    const { codes, pake, now } = setup();
    const code = codes.issue(ticket(now.value + 120_000));
    codes.issue(ticket(now.value + 120_000, "c"));
    const phone = app(code);
    const offers = offersOf(
      pake.start({ ...phone.start, remoteIp: "10.0.0.2" }),
    );
    const finish = phone.answer(offers)!;
    const wrongIndex = { ...finish, index: finish.index === 0 ? 1 : 0 };
    expect(pake.finish(wrongIndex).ok).toBe(false);
    expect(pake.finish(finish).ok).toBe(false);
  });

  it("会话 30 秒过期", () => {
    const { codes, pake, now } = setup();
    const code = codes.issue(ticket(now.value + 120_000));
    const phone = app(code);
    const offers = offersOf(
      pake.start({ ...phone.start, remoteIp: "10.0.0.2" }),
    );
    const finish = phone.answer(offers)!;
    now.value += PAKE_SESSION_TTL_MS;
    expect(pake.finish(finish)).toEqual({ ok: false, reason: "invalid" });
  });

  it("票已被扫码兑掉：标签对了也不答票", () => {
    const { codes, pake, now } = setup();
    const code = codes.issue(ticket(now.value + 120_000));
    const phone = app(code);
    const finish = phone.answer(
      offersOf(pake.start({ ...phone.start, remoteIp: "10.0.0.2" })),
    )!;
    expect(pake.finish(finish, () => "dead")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("每次 start 扣一次猜测：来源桶空了答 rate_limited，别的来源不受影响", () => {
    const { codes, pake, now } = setup();
    codes.issue(ticket(now.value + 120_000));
    let limited: ReturnType<PairingPake["start"]> | undefined;
    for (let index = 0; index < 25; index += 1) {
      const result = pake.start({
        ...app("AAAAAAAA").start,
        remoteIp: "10.0.0.9",
      });
      if (!result.ok) {
        limited = result;
        break;
      }
    }
    expect(limited).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(
      pake.start({ ...app("AAAAAAAA").start, remoteIp: "10.0.0.10" }).ok,
    ).toBe(true);
  });

  it("App 的份额不是合法群元素：bad_share，不扣令牌", () => {
    const { codes, pake, now } = setup();
    codes.issue(ticket(now.value + 120_000));
    const start = app("AAAAAAAA").start;
    expect(
      pake.start({
        ...start,
        share: toBase64Url(new Uint8Array(32).fill(0xff)),
        remoteIp: "10.0.0.2",
      }),
    ).toEqual({ ok: false, reason: "bad_share" });
    expect(
      pake.start({
        ...start,
        share: toBase64Url(new Uint8Array(32)),
        remoteIp: "10.0.0.2",
      }),
    ).toEqual({ ok: false, reason: "bad_share" });
  });

  it("没有活着的短码：候选是空的", () => {
    const { pake } = setup();
    const offers = offersOf(
      pake.start({ ...app("AAAAAAAA").start, remoteIp: "10.0.0.2" }),
    );
    expect(offers.offers).toEqual([]);
    expect(offers.session).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("clear 之后会话全没", () => {
    const { codes, pake, now } = setup();
    const code = codes.issue(ticket(now.value + 120_000));
    const phone = app(code);
    const finish = phone.answer(
      offersOf(pake.start({ ...phone.start, remoteIp: "10.0.0.2" })),
    )!;
    pake.clear();
    expect(pake.finish(finish).ok).toBe(false);
  });
});
