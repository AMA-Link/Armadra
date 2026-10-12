/**
 * 配对与访客链接（契约 §80，设计 §4.9、§4.10）：新设备首次进来时证明「我拿到过一样只在
 * 可信渠道出现的秘密」，于是不必等主人核对校验码。
 *
 * - **配对秘密**：本机（或已信任设备经它的通道）签一枚 16 字节、5 分钟、一次性的秘密，
 *   连同身份公钥放进二维码。新设备握手 m3 带 `proof = HMAC(HKDF(秘密), 转录)`，登录时
 *   在这里找一枚对得上的、取走 → 直接信任（`approved_by = pairing`）。秘密只在内存。
 * - **访客链接**：链接片段里的邀请令牌就是秘密；第一次加入时 `proof` 对得上 → 绑到访客
 *   主体（`approved_by = link:<linkId>`），名额按 `share_links.max_devices`。
 */

import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** 配对秘密活多久。 */
export const PAIRING_SECRET_TTL_MS = 5 * 60_000;
/** 同时活着的配对秘密上限（满了挤最老的）。 */
const PAIRING_SECRETS_MAX = 16;

export interface PairingSecret {
  readonly secret: Uint8Array;
  readonly expiresAtMs: number;
}

export class PairingSecrets {
  private live: PairingSecret[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  issue(): PairingSecret {
    this.prune();
    const issued = {
      secret: new Uint8Array(randomBytes(16)),
      expiresAtMs: this.now() + PAIRING_SECRET_TTL_MS,
    };
    this.live.push(issued);
    if (this.live.length > PAIRING_SECRETS_MAX) this.live.shift();
    return issued;
  }

  /** 找一枚让 `verify` 成立的、取走它；没有答 `false`。 */
  async consume(
    verify: (secret: Uint8Array) => Promise<boolean>,
  ): Promise<boolean> {
    this.prune();
    for (const entry of [...this.live]) {
      if (await verify(entry.secret)) {
        this.live = this.live.filter((one) => one !== entry);
        return true;
      }
    }
    return false;
  }

  private prune(): void {
    const at = this.now();
    this.live = this.live.filter((entry) => entry.expiresAtMs > at);
  }
}

export interface ShareLinkRecord {
  readonly linkId: string;
  readonly issuer: string;
  readonly invitationId: string;
  /** `null` = 不限。 */
  readonly maxDevices: number | null;
  readonly identityFpShown: string;
  readonly createdAtMs: number;
  readonly revokedAtMs: number;
}

/** `share_links`（迁移 0051）的读写。 */
export class ShareLinkStore {
  constructor(private readonly database: DatabaseSync) {}

  save(row: ShareLinkRecord): void {
    this.database
      .prepare(
        "INSERT INTO share_links(link_id, issuer, invitation_id, max_devices, identity_fp_shown, created_at_ms, revoked_at_ms) " +
          "VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(link_id) DO UPDATE SET issuer = excluded.issuer, " +
          "invitation_id = excluded.invitation_id, max_devices = excluded.max_devices, " +
          "identity_fp_shown = excluded.identity_fp_shown",
      )
      .run(
        row.linkId,
        row.issuer,
        row.invitationId,
        row.maxDevices,
        row.identityFpShown,
        row.createdAtMs,
        row.revokedAtMs,
      );
  }

  get(linkId: string): ShareLinkRecord | undefined {
    const row = this.database
      .prepare(
        "SELECT link_id, issuer, invitation_id, max_devices, identity_fp_shown, created_at_ms, revoked_at_ms " +
          "FROM share_links WHERE link_id = ?",
      )
      .get(linkId) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return {
      linkId: String(row.link_id),
      issuer: String(row.issuer),
      invitationId: String(row.invitation_id),
      maxDevices: row.max_devices === null ? null : Number(row.max_devices),
      identityFpShown: String(row.identity_fp_shown),
      createdAtMs: Number(row.created_at_ms),
      revokedAtMs: Number(row.revoked_at_ms),
    };
  }

  revoke(linkId: string, atMs: number): void {
    this.database
      .prepare(
        "UPDATE share_links SET revoked_at_ms = ? WHERE link_id = ? AND revoked_at_ms = 0",
      )
      .run(atMs, linkId);
  }
}

/** 「approved_by」里访客链接的写法。 */
export function linkApprover(linkId: string): string {
  return `link:${linkId}`;
}
