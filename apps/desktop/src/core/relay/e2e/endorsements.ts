/**
 * 设备背书的通知记录（契约 §81.1，迁移 0056 `device_endorsements`）。
 *
 * 每次 `approved_by = endorse:*` 的放行在主机上记一行：没人看着画布时即时事件会丢，这一行
 * 不会。主人看过之后标已读，从「需要人处理」里消失。名字在背书那一刻抄下来——之后设备被改名、
 * 删掉，这一行仍说得清当时放行的是谁的哪台设备、是哪台设备放的。
 *
 * 只有标识与名字，没有校验码、会话或任何凭据。
 */
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface EndorsementRecord {
  readonly id: string;
  readonly deviceId: string;
  readonly principalId: string;
  readonly principalName: string;
  readonly deviceLabel: string;
  readonly devicePlatform: string;
  readonly endorserDeviceId: string;
  readonly endorserPrincipalId: string;
  readonly endorserLabel: string;
  readonly createdAtMs: number;
}

/** 一次背书（`devices.endorsed` 的那四个标识）。 */
export interface Endorsement {
  readonly deviceId: string;
  readonly principalId: string;
  readonly endorserDeviceId: string;
  readonly endorserPrincipalId: string;
}

/** 一次最多列多少条未读；更早的仍在库里，标掉新的之后会露出来。 */
export const UNREAD_LIMIT = 100;
/** 已读的行留多久（毫秒）：之后在下一次记录时清掉，这张表不只长不缩。 */
export const READ_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** 按码点截（库里 `length()` 也按字符算）：不把 emoji 截成孤立的代理字符。 */
function clip(value: unknown, max: number): string {
  return typeof value === "string" ? [...value].slice(0, max).join("") : "";
}

function toRecord(row: Record<string, unknown>): EndorsementRecord {
  return {
    id: String(row.id),
    deviceId: String(row.device_id),
    principalId: String(row.principal_id),
    principalName: String(row.principal_name),
    deviceLabel: String(row.device_label),
    devicePlatform: String(row.device_platform),
    endorserDeviceId: String(row.endorser_device_id),
    endorserPrincipalId: String(row.endorser_principal_id),
    endorserLabel: String(row.endorser_label),
    createdAtMs: Number(row.created_at_ms),
  };
}

export class EndorsementStore {
  private readonly now: () => number;

  constructor(
    private readonly database: DatabaseSync,
    now: () => number = Date.now,
  ) {
    this.now = now;
  }

  /** 记一次背书，名字按此刻的设备登记与主体抄下。 */
  record(endorsement: Endorsement): EndorsementRecord {
    const at = this.now();
    const device = this.database
      .prepare(
        "SELECT label, platform FROM trusted_devices WHERE device_id = ? AND principal_id = ?",
      )
      .get(endorsement.deviceId, endorsement.principalId) as
      | { label?: string; platform?: string }
      | undefined;
    const principal = this.database
      .prepare(
        "SELECT display_name FROM identity_principals WHERE principal_id = ?",
      )
      .get(endorsement.principalId) as { display_name?: string } | undefined;
    const endorser = this.database
      .prepare(
        "SELECT label FROM trusted_devices WHERE device_id = ? AND principal_id = ?",
      )
      .get(endorsement.endorserDeviceId, endorsement.endorserPrincipalId) as
      | { label?: string }
      | undefined;
    const record: EndorsementRecord = {
      id: randomBytes(16).toString("hex"),
      deviceId: endorsement.deviceId.slice(0, 64),
      principalId: endorsement.principalId.slice(0, 128),
      principalName: clip(principal?.display_name, 128),
      deviceLabel: clip(device?.label, 128),
      devicePlatform: clip(device?.platform, 32),
      endorserDeviceId: endorsement.endorserDeviceId.slice(0, 64),
      endorserPrincipalId: endorsement.endorserPrincipalId.slice(0, 128),
      endorserLabel: clip(endorser?.label, 128),
      createdAtMs: at,
    };
    this.database
      .prepare(
        "INSERT INTO device_endorsements(id, device_id, principal_id, principal_name, device_label, device_platform, " +
          "endorser_device_id, endorser_principal_id, endorser_label, created_at_ms) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        record.id,
        record.deviceId,
        record.principalId,
        record.principalName,
        record.deviceLabel,
        record.devicePlatform,
        record.endorserDeviceId,
        record.endorserPrincipalId,
        record.endorserLabel,
        record.createdAtMs,
      );
    this.database
      .prepare(
        "DELETE FROM device_endorsements WHERE read_at_ms > 0 AND read_at_ms < ?",
      )
      .run(at - READ_RETENTION_MS);
    return record;
  }

  /** 未读的，新的在前。 */
  unread(limit = UNREAD_LIMIT): EndorsementRecord[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM device_endorsements WHERE read_at_ms = 0 ORDER BY created_at_ms DESC, id LIMIT ?",
        )
        .all(limit) as Record<string, unknown>[]
    ).map(toRecord);
  }

  /** 标已读；不认识或已读的 id 略过。答这次标了几条。 */
  markRead(ids: readonly string[]): number {
    const at = this.now();
    const statement = this.database.prepare(
      "UPDATE device_endorsements SET read_at_ms = ? WHERE id = ? AND read_at_ms = 0",
    );
    let changed = 0;
    for (const id of new Set(ids))
      changed += Number(statement.run(at, id).changes);
    return changed;
  }
}
