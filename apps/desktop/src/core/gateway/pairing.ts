/**
 * 配对票的网页链接与换票回答（架构 §7，契约 §17、§24）。
 *
 *   * 网页：`https://<host>:<port>/#pair=<票>&fp=<指纹>`。票只进片段——片段不上
 *     请求行，于是不进任何访问日志，也不进 `Referer`。
 *   * 手机扫码：二维码是 `connect.offer` 拼的 `<网页来源>/#c=2&…`（契约 §99），不是
 *     这里的链接；App 按 `fp` 钉信任锚（有本地 CA 时是 CA，指定文件时是叶证书），不装 CA。
 *
 * 票两分钟、一次性（`identity/service.ts` 的 `BOOTSTRAP_TTL_MS`），绑在 `origin`
 * 上：用别的来源兑换是 401。
 */

export interface PairingTicket {
  readonly ticket: string;
  readonly expiresAtMs: number;
  /** 票绑定的 Gateway 来源（集合里的第一个）。 */
  readonly origin: string;
  /** 票能在哪些来源兑换（契约 §99.3）；`origin` 是其中第一个。 */
  readonly origins: readonly string[];
  /** 信任锚 DER 的 SHA-256，小写十六进制。 */
  readonly fingerprint: string;
  readonly webUrl: string;
}

export function pairingLinks(
  origin: string,
  ticket: string,
  fingerprint: string,
): { webUrl: string } {
  return { webUrl: `${origin}/#pair=${ticket}&fp=${fingerprint}` };
}

/** 短码换票与 PAKE 的回答（契约 §24、§73）。 */
export function pairingJson(ticket: PairingTicket): Record<string, unknown> {
  return {
    origin: ticket.origin,
    ticket: ticket.ticket,
    fingerprint: ticket.fingerprint,
    expiresAt: new Date(ticket.expiresAtMs).toISOString(),
    webUrl: ticket.webUrl,
  };
}
