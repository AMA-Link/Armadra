import {
  type GatewayPairingPayload,
  PAIRING_PAKE_MAX_OFFERS,
  type PairingPakeFinish,
  type PairingPakeOffers,
  type PairingPakeStart,
  fromBase64Url,
  newPakeSid,
  pakeConfirm,
  pakeConfirmEquals,
  pakeKey,
  pakeShare,
  toBase64Url,
} from "@armadra/shared";

/**
 * 配对码 PAKE，App 这一半（契约 §73，#338）。
 *
 * 只做协议：出份额，对 Gateway 给的每个候选算会话密钥、用**自己拨的来源与
 * 自己取到的指纹**核对它的标签；一个都对不上就停下，**不发 finish**——码错，
 * 或这条连接上不是配对卡上的那台（证书被换了）。对上了才出客户端标签换票。
 * 发请求由调用方给（`api/gateway.ts`），这里不碰网络、不碰钉扎。
 */

export interface PakeTransport {
  start(body: PairingPakeStart): Promise<PairingPakeOffers>;
  finish(body: PairingPakeFinish): Promise<GatewayPairingPayload>;
}

export type PakeOutcome =
  | { readonly kind: "paired"; readonly payload: GatewayPairingPayload }
  /** 没有一个候选的标签对得上：码错，或证书被换。 */
  | { readonly kind: "mismatch" };

export async function runPairingPake(input: {
  readonly code: string;
  /** App 拨的 Gateway 来源（`https://host:port`）。 */
  readonly origin: string;
  /** App 取到并已暂钉的信任锚指纹。 */
  readonly fingerprint: string;
  readonly transport: PakeTransport;
}): Promise<PakeOutcome> {
  const sid = newPakeSid();
  const mine = pakeShare(input.code, sid);
  const offers = await input.transport.start({
    sid: toBase64Url(sid),
    share: toBase64Url(mine.share),
  });
  // 多于上限的候选不是一台正常的 Gateway 给得出来的：只看前面那些，免得冒充
  // Gateway 的一方借一次失败多试几枚码。
  for (const [index, offer] of offers.offers
    .slice(0, PAIRING_PAKE_MAX_OFFERS)
    .entries()) {
    const responder = fromBase64Url(offer.share, 32);
    const presented = fromBase64Url(offer.confirm, 32);
    if (responder === null || presented === null) continue;
    const isk = pakeKey({
      secret: mine.secret,
      peer: responder,
      sid,
      initiator: mine.share,
      responder,
    });
    if (isk === null) continue;
    const expected = pakeConfirm(
      isk,
      "server",
      input.origin,
      input.fingerprint,
    );
    if (!pakeConfirmEquals(expected, presented)) continue;
    const payload = await input.transport.finish({
      session: offers.session,
      index,
      confirm: toBase64Url(
        pakeConfirm(isk, "client", input.origin, input.fingerprint),
      ),
    });
    return { kind: "paired", payload };
  }
  return { kind: "mismatch" };
}
