import {
  type ConnectPayload,
  type ConnectRejection,
  parseConnect,
} from "@armadra/shared";

import { pairWithGateway } from "../api/identity";
import { probeDirect } from "../sources/routing";
import {
  type PairingOffer,
  offerFromConnect,
  storagePairings,
} from "../sources/e2e/pairing";
import type { ConnectFailure } from "./ConnectScreen";
import {
  type NativeConnectDeps,
  type RelayEnrollment,
  failureOf,
  nativeDeps,
} from "./connect";

/**
 * 连接手机的二维码（契约 §99.5）：手机端选路。
 *
 * 1. 有直连半：对每个来源先钉信任锚，再并行问 `hello`（1.5 秒），只有答回的 `hostId` 就是
 *    二维码里的源才算通；窗口结束后取顺序最靠前的那个，用票配对（10 秒）。配对答 401 / 403 /
 *    410 报「已过期」，不改走中转；传输失败按不可达处理。
 * 2. 直连不通、有中转半：记下 offer（秘密到期即丢），交给界面走中转（钥匙串里有登录就
 *    直接挂源，没有就登录后自动挂）。
 * 3. 直连成功、有中转半：同样记下 offer，钥匙串里有登录时后台顺带挂中转路线。
 */

/** 配对请求的上限。 */
export const OFFER_PAIR_TIMEOUT_MS = 10_000;
/** 票两分钟、秘密五分钟：二维码的截止取最早的，中转半的秘密比它多活这么久。 */
const SECRET_EXTRA_MS = 3 * 60_000;

export type OfferOutcome =
  | { readonly kind: "done" }
  /** 直连没连上，接着走中转：`sourceId` 是要挂的源，`issuers` 是它登记的远程服务。 */
  | {
      readonly kind: "relay";
      readonly sourceId: string;
      readonly issuers: readonly string[];
    }
  | { readonly kind: "failure"; readonly failure: ConnectFailure };

/** 解析失败的原因 → 连接页的文案键。 */
export function rejectionFailure(reason: ConnectRejection): ConnectFailure {
  switch (reason) {
    case "older":
      return "connectOlder";
    case "newer":
      return "connectNewer";
    case "expired":
      return "offerExpired";
    case "invalid":
      return "invalid";
  }
}

/** 文本是不是连接手机的二维码（带 `#c=`，不论合不合规矩）；其余形状走原来的解析。 */
export function looksLikeConnect(text: string): boolean {
  return /^https?:\/\/[^#]*#c=/i.test(text.trim());
}

export interface OfferDeps {
  readonly native: NativeConnectDeps;
  readonly probe: (origin: string, sourceId: string) => Promise<boolean>;
  readonly pair: (origin: string, ticket: string) => Promise<unknown>;
  readonly remember: (offer: PairingOffer) => void;
  /** 后台顺带挂中转路线（钥匙串里有登录才会成功）；失败不影响直连。 */
  readonly attach?: RelayEnrollment["attach"];
  readonly now?: () => number;
  readonly pairTimeoutMs?: number;
}

function defaults(relay: RelayEnrollment | undefined): OfferDeps {
  return {
    native: nativeDeps(),
    probe: (origin, sourceId) => probeDirect(origin, sourceId),
    pair: pairWithGateway,
    remember: (offer) => storagePairings().remember(offer),
    ...(relay === undefined ? {} : { attach: relay.attach.bind(relay) }),
  };
}

function rememberRelay(payload: ConnectPayload, deps: OfferDeps): void {
  if (payload.relay === null) return;
  const offer = offerFromConnect(
    payload.sourceId,
    payload.expiresAtMs + (payload.direct === null ? 0 : SECRET_EXTRA_MS),
    payload.relay,
  );
  if (offer !== null) deps.remember(offer);
}

function timeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** 按载荷选路并连接；成功时页面已重载。 */
export async function connectOffer(
  payload: ConnectPayload,
  relay?: RelayEnrollment,
  deps: OfferDeps = defaults(relay),
): Promise<OfferOutcome> {
  const now = (deps.now ?? Date.now)();
  if (payload.expiresAtMs + 60_000 <= now) {
    return { kind: "failure", failure: "offerExpired" };
  }
  const viaRelay = (): OfferOutcome => {
    if (payload.relay === null) {
      return { kind: "failure", failure: "offerUnreachable" };
    }
    rememberRelay(payload, deps);
    return {
      kind: "relay",
      sourceId: payload.sourceId,
      issuers: payload.relay.issuers,
    };
  };
  const direct = payload.direct;
  if (direct === null) return viaRelay();

  // 每个来源：先钉信任锚，再问 hello；钉不上也是这个来源不通。
  const reachable = await Promise.all(
    direct.origins.map(async (origin) => {
      try {
        await deps.native.bridge.pin(origin, direct.fingerprint);
      } catch {
        return false;
      }
      return deps.probe(origin, payload.sourceId);
    }),
  );
  const origin = direct.origins.find((_, index) => reachable[index]);
  if (origin === undefined) return viaRelay();

  try {
    await timeout(
      deps.pair(origin, direct.ticket),
      deps.pairTimeoutMs ?? OFFER_PAIR_TIMEOUT_MS,
    );
  } catch (error) {
    const failure =
      error instanceof Error && error.message === "timeout"
        ? "unreachable"
        : failureOf(error);
    // 票过期或被兑掉：报过期，不改走中转。传输层失败才算不可达。
    if (failure === "unreachable") return viaRelay();
    return {
      kind: "failure",
      failure: failure === "expired" ? "offerExpired" : failure,
    };
  }
  const hostName = (await deps.native.hostName?.(origin)) ?? "";
  deps.native.record?.({
    sourceId: payload.sourceId,
    origin,
    fingerprint: direct.fingerprint,
    ...(hostName ? { hostName } : {}),
  });
  deps.native.save(origin);
  if (payload.relay !== null) {
    rememberRelay(payload, deps);
    // 同一连接多一条中转路线；没登录过就等之后登录时再挂（那时秘密可能已过期）。
    await deps
      .attach?.(
        { sourceId: payload.sourceId, issuers: payload.relay.issuers },
        { quiet: true },
      )
      .catch(() => undefined);
  }
  deps.native.reload();
  return { kind: "done" };
}

/** 文本 → 载荷或失败；`now` 给了就核截止时刻。 */
export function readConnect(
  text: string,
  now: number = Date.now(),
):
  | { readonly ok: true; readonly payload: ConnectPayload }
  | { readonly ok: false; readonly failure: ConnectFailure } {
  const parsed = parseConnect(text, now);
  return parsed.ok
    ? { ok: true, payload: parsed.payload }
    : { ok: false, failure: rejectionFailure(parsed.reason) };
}
