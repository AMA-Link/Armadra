import { randomBytes, randomInt } from "node:crypto";

import {
  PAIRING_PAKE_MAX_OFFERS,
  PAIRING_PAKE_SID_BYTES,
  type PairingPakeFinish,
  type PairingPakeOffers,
  type PairingPakeStart,
  fromBase64Url,
  pakeConfirm,
  pakeConfirmEquals,
  pakeKey,
  pakeShare,
  toBase64Url,
} from "@armadra/shared";

import type { PairingTicket } from "./pairing";
import type { PairingCodes, TicketCheck } from "./pairing-code";

/**
 * 配对码的口令认证密钥交换，Gateway 这一半（契约 §73，#338）。
 *
 * 原生 App 第一次连一个没钉过信任锚的 Gateway：它只能从不带凭据的 `peek` 拿到
 * 一个指纹，那可能是中间人的。所以 App 不发配对码，而是和 Gateway 用配对码做
 * 一次 CPace（`@armadra/shared` 的 `pairing-pake.ts`），确认标签里绑上各自看到
 * 的来源与信任锚指纹：
 *
 *   * **start**：App 给 `{ sid, share }`。Gateway 不知道它输的是哪一枚，于是对
 *     每一枚活着的短码各出一份 `{ share, confirm }`（`confirm` 是 Gateway 用
 *     自己的来源与指纹算的标签），记下各自的会话密钥，答一个会话号。这一步就
 *     扣一次猜测的令牌（与 `exchange` 猜错同一组桶）。
 *   * **finish**：App 在本地核对出第 j 个候选的标签，才给 `{ session, index: j,
 *     confirm }`。Gateway 用自己的来源与指纹核对客户端标签，对了就取走那枚短码
 *     并答配对载荷（与 §17.3 同形）。会话不论对错都作废，一次 start 只能 finish
 *     一次。
 *
 * 会话 30 秒、只在内存，最多 {@link PAKE_SESSION_LIMIT} 个，满了挤最老的。
 */

export const PAKE_SESSION_TTL_MS = 30_000;
export const PAKE_SESSION_LIMIT = 64;

interface Candidate {
  readonly code: string;
  readonly isk: Uint8Array;
  readonly origin: string;
  readonly fingerprint: string;
}

interface Pending {
  readonly expiresAtMs: number;
  readonly candidates: readonly Candidate[];
}

export type PakeStartResult =
  | { readonly ok: true; readonly body: PairingPakeOffers }
  | {
      readonly ok: false;
      readonly reason: "rate_limited";
      readonly retryAfterMs: number;
    }
  | { readonly ok: false; readonly reason: "bad_share" };

export type PakeFinishResult =
  | { readonly ok: true; readonly ticket: PairingTicket }
  | { readonly ok: false; readonly reason: "invalid" };

export class PairingPake {
  private readonly sessions = new Map<string, Pending>();

  constructor(
    private readonly codes: PairingCodes,
    private readonly now: () => number = Date.now,
  ) {}

  start(
    input: PairingPakeStart & { readonly remoteIp: string },
  ): PakeStartResult {
    const sid = fromBase64Url(input.sid, PAIRING_PAKE_SID_BYTES);
    const initiator = fromBase64Url(input.share, 32);
    if (sid === null || initiator === null)
      return { ok: false, reason: "bad_share" };
    const admitted = this.codes.admitGuess(input.remoteIp);
    if (!admitted.ok) {
      return {
        ok: false,
        reason: "rate_limited",
        retryAfterMs: admitted.retryAfterMs,
      };
    }
    const offers: { share: string; confirm: string }[] = [];
    const candidates: Candidate[] = [];
    for (const [code, ticket] of this.codes
      .live()
      .slice(0, PAIRING_PAKE_MAX_OFFERS)) {
      const mine = pakeShare(code, sid);
      const isk = pakeKey({
        secret: mine.secret,
        peer: initiator,
        sid,
        initiator,
        responder: mine.share,
      });
      // 对方的元素不合法（或是单位元）：对哪一枚都一样，整次拒绝。
      if (isk === null) return { ok: false, reason: "bad_share" };
      candidates.push({
        code,
        isk,
        origin: ticket.origin,
        fingerprint: ticket.fingerprint,
      });
      offers.push({
        share: toBase64Url(mine.share),
        confirm: toBase64Url(
          pakeConfirm(isk, "server", ticket.origin, ticket.fingerprint),
        ),
      });
    }
    // 候选的次序打乱：不让次序透露哪一枚签得早。
    const order = shuffled(offers.length);
    const session = toBase64Url(randomBytes(16));
    this.sweep();
    if (this.sessions.size >= PAKE_SESSION_LIMIT) {
      const oldest = this.sessions.keys().next().value as string;
      this.sessions.delete(oldest);
    }
    this.sessions.set(session, {
      expiresAtMs: this.now() + PAKE_SESSION_TTL_MS,
      candidates: order.map((index) => candidates[index] as Candidate),
    });
    return {
      ok: true,
      body: {
        session,
        offers: order.map((index) => offers[index] as (typeof offers)[number]),
      },
    };
  }

  finish(
    input: PairingPakeFinish,
    check: (ticket: PairingTicket) => TicketCheck = () => "ok",
  ): PakeFinishResult {
    const pending = this.sessions.get(input.session);
    // 一次性：不论对错都作废，猜下一枚得重新 start（再扣一次令牌）。
    this.sessions.delete(input.session);
    if (pending === undefined || pending.expiresAtMs <= this.now()) {
      return { ok: false, reason: "invalid" };
    }
    const candidate = pending.candidates[input.index];
    const presented = fromBase64Url(input.confirm, 32);
    if (candidate === undefined || presented === null) {
      return { ok: false, reason: "invalid" };
    }
    const expected = pakeConfirm(
      candidate.isk,
      "client",
      candidate.origin,
      candidate.fingerprint,
    );
    if (!pakeConfirmEquals(expected, presented)) {
      return { ok: false, reason: "invalid" };
    }
    const ticket = this.codes.take(candidate.code, check);
    return ticket === undefined
      ? { ok: false, reason: "invalid" }
      : { ok: true, ticket };
  }

  /** 关掉 Gateway 或换档时：全部作废。 */
  clear(): void {
    this.sessions.clear();
  }

  get size(): number {
    this.sweep();
    return this.sessions.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [session, pending] of this.sessions) {
      if (pending.expiresAtMs <= now) this.sessions.delete(session);
    }
  }
}

/** `0..n-1` 的一个均匀随机排列。 */
function shuffled(n: number): number[] {
  const order = Array.from({ length: n }, (_, index) => index);
  for (let index = n - 1; index > 0; index -= 1) {
    const pick = randomInt(index + 1);
    [order[index], order[pick]] = [
      order[pick] as number,
      order[index] as number,
    ];
  }
  return order;
}
