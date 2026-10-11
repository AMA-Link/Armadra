/**
 * 端到端通道的设备钥登记（契约 §77，迁移 0050 `trusted_devices`）。
 *
 * 一把设备钥（Ed25519 公钥）对每个主体各有一行：
 *
 *   * 第一次以某个主体登录（`cloud/login` 经通道）且没有已信任的行 → 建 `pending`
 *     行，答 `403 device_pending { pendingId }`；主人在本机核对新设备屏幕上的 6 位
 *     校验码（通道握手推出来的 `sas`）后 `approve` → `trusted`，`approved_by = local`。
 *   * 扫码配对、已信任设备背书、访客链接（E4）直接写 `trusted`，各记来路。
 *   * `reject` → `rejected`：同一把钥再来也直接答 `403 device_rejected`；撤销 → `revoked`，
 *     并吊销经这把钥签的会话、断开它的通道。被拒或撤销的钥要主人在设备列表里删掉
 *     这一行（`forget`）才能重新申请。
 *
 * 校验码只在内存：它属于某一条通道，core 重启或通道重建后由新通道重新登记。
 * 没有它就批不了（`sas_expired`），新设备重连一次即可。
 */

import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { fail } from "../../http/errors";

export type DeviceStatus = "pending" | "trusted" | "rejected" | "revoked";

export interface TrustedDeviceRow {
  readonly deviceId: string;
  readonly principalId: string;
  readonly publicKey: Buffer;
  readonly label: string;
  readonly platform: string;
  readonly status: DeviceStatus;
  readonly requestId: string;
  readonly approvedBy: string;
  readonly issuer: string;
  readonly issuerDeviceId: string;
  readonly createdAtMs: number;
  readonly approvedAtMs: number;
  readonly lastSeenAtMs: number;
  readonly revokedAtMs: number;
}

/** 列表里的一行：多一个主体的显示名与种类。 */
export interface DeviceView extends TrustedDeviceRow {
  readonly principalName: string;
  readonly principalKind: string;
}

/** 设备 id：公钥 SHA-256 的前 16 字节（32 位十六进制）。 */
export function deviceIdOf(publicKey: Uint8Array): string {
  return createHash("sha256").update(publicKey).digest("hex").slice(0, 32);
}

const LABEL_MAX = 128;
const PLATFORM_MAX = 32;

function clip(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function toRow(row: Record<string, unknown>): TrustedDeviceRow {
  return {
    deviceId: String(row.device_id),
    principalId: String(row.principal_id),
    publicKey: Buffer.from(row.public_key as Uint8Array),
    label: String(row.label),
    platform: String(row.platform),
    status: row.status as DeviceStatus,
    requestId: String(row.request_id),
    approvedBy: String(row.approved_by),
    issuer: String(row.issuer),
    issuerDeviceId: String(row.issuer_device_id),
    createdAtMs: Number(row.created_at_ms),
    approvedAtMs: Number(row.approved_at_ms),
    lastSeenAtMs: Number(row.last_seen_at_ms),
    revokedAtMs: Number(row.revoked_at_ms),
  };
}

const COLUMNS =
  "d.device_id, d.principal_id, d.public_key, d.label, d.platform, d.status, d.request_id, " +
  "d.approved_by, d.issuer, d.issuer_device_id, d.created_at_ms, d.approved_at_ms, " +
  "d.last_seen_at_ms, d.revoked_at_ms";

/** `trusted_devices` 的读写；不发事件、不碰内存状态。 */
export class TrustedDeviceStore {
  constructor(private readonly database: DatabaseSync) {}

  get(deviceId: string, principalId: string): TrustedDeviceRow | undefined {
    const row = this.database
      .prepare(
        `SELECT ${COLUMNS} FROM trusted_devices d WHERE d.device_id = ? AND d.principal_id = ?`,
      )
      .get(deviceId, principalId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toRow(row);
  }

  byRequest(requestId: string): TrustedDeviceRow | undefined {
    const row = this.database
      .prepare(
        `SELECT ${COLUMNS} FROM trusted_devices d WHERE d.request_id = ?`,
      )
      .get(requestId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toRow(row);
  }

  forDevice(deviceId: string): TrustedDeviceRow[] {
    return (
      this.database
        .prepare(
          `SELECT ${COLUMNS} FROM trusted_devices d WHERE d.device_id = ?`,
        )
        .all(deviceId) as Record<string, unknown>[]
    ).map(toRow);
  }

  list(): DeviceView[] {
    return (
      this.database
        .prepare(
          `SELECT ${COLUMNS}, p.display_name AS principal_name, p.kind AS principal_kind ` +
            "FROM trusted_devices d JOIN identity_principals p ON p.principal_id = d.principal_id " +
            "ORDER BY d.created_at_ms DESC, d.device_id",
        )
        .all() as Record<string, unknown>[]
    ).map((row) => ({
      ...toRow(row),
      principalName: String(row.principal_name),
      principalKind: String(row.principal_kind),
    }));
  }

  /** 来自某个访客链接、仍算名额的行数（trusted 与 pending）。 */
  countApprovedBy(approvedBy: string): number {
    const row = this.database
      .prepare(
        "SELECT COUNT(*) AS n FROM trusted_devices WHERE approved_by = ? AND status IN ('trusted', 'pending')",
      )
      .get(approvedBy) as { n: number };
    return Number(row.n);
  }

  insert(row: TrustedDeviceRow): void {
    this.database
      .prepare(
        "INSERT INTO trusted_devices(device_id, principal_id, public_key, label, platform, status, request_id, " +
          "approved_by, issuer, issuer_device_id, created_at_ms, approved_at_ms, last_seen_at_ms, revoked_at_ms) " +
          "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.deviceId,
        row.principalId,
        new Uint8Array(row.publicKey),
        clip(row.label, LABEL_MAX),
        clip(row.platform, PLATFORM_MAX),
        row.status,
        row.requestId,
        row.approvedBy,
        row.issuer,
        row.issuerDeviceId,
        row.createdAtMs,
        row.approvedAtMs,
        row.lastSeenAtMs,
        row.revokedAtMs,
      );
  }

  setStatus(
    deviceId: string,
    principalId: string,
    status: DeviceStatus,
    fields: { approvedBy?: string; atMs: number },
  ): boolean {
    const result = this.database
      .prepare(
        "UPDATE trusted_devices SET status = ?, " +
          "approved_by = CASE WHEN ? IS NULL THEN approved_by ELSE ? END, " +
          "approved_at_ms = CASE WHEN ? = 'trusted' THEN ? ELSE approved_at_ms END, " +
          "revoked_at_ms = CASE WHEN ? IN ('revoked', 'rejected') THEN ? ELSE revoked_at_ms END " +
          "WHERE device_id = ? AND principal_id = ?",
      )
      .run(
        status,
        fields.approvedBy ?? null,
        fields.approvedBy ?? null,
        status,
        fields.atMs,
        status,
        fields.atMs,
        deviceId,
        principalId,
      );
    return Number(result.changes) > 0;
  }

  /** 重新进入待确认：换新的 request_id，名字与平台按这一次的来。 */
  repend(
    deviceId: string,
    principalId: string,
    fields: { requestId: string; label: string; platform: string },
  ): void {
    this.database
      .prepare(
        "UPDATE trusted_devices SET request_id = ?, label = ?, platform = ? WHERE device_id = ? AND principal_id = ?",
      )
      .run(
        fields.requestId,
        clip(fields.label, LABEL_MAX),
        clip(fields.platform, PLATFORM_MAX),
        deviceId,
        principalId,
      );
  }

  rename(deviceId: string, principalId: string, label: string): boolean {
    const result = this.database
      .prepare(
        "UPDATE trusted_devices SET label = ? WHERE device_id = ? AND principal_id = ?",
      )
      .run(clip(label, LABEL_MAX), deviceId, principalId);
    return Number(result.changes) > 0;
  }

  touch(deviceId: string, principalId: string, atMs: number): void {
    this.database
      .prepare(
        "UPDATE trusted_devices SET last_seen_at_ms = ? WHERE device_id = ? AND principal_id = ? AND last_seen_at_ms < ?",
      )
      .run(atMs, deviceId, principalId, atMs - 60_000);
  }

  remove(deviceId: string, principalId: string): boolean {
    const result = this.database
      .prepare(
        "DELETE FROM trusted_devices WHERE device_id = ? AND principal_id = ?",
      )
      .run(deviceId, principalId);
    return Number(result.changes) > 0;
  }

  /** 吊销经这把设备钥、以这个主体签的会话；答吊销了几条。 */
  revokeSessions(deviceId: string, principalId: string, atMs: number): number {
    const result = this.database
      .prepare(
        "UPDATE identity_sessions SET revoked_at_ms = ? WHERE channel_device_id = ? AND revoked_at_ms = 0 " +
          "AND device_id IN (SELECT device_id FROM identity_devices WHERE principal_id = ?)",
      )
      .run(atMs, deviceId, principalId);
    return Number(result.changes);
  }
}

/** 一次经通道的登录在设备这一关的结论。 */
export type DeviceVerdict =
  | { readonly status: "trusted"; readonly approvedBy: string }
  | { readonly status: "pending"; readonly requestId: string }
  | { readonly status: "rejected" };

/** 通道这一侧报给 {@link DeviceRegistry.admit} 的设备。 */
export interface ChannelDevice {
  readonly deviceId: string;
  readonly publicKey: Uint8Array;
  readonly label: string;
  readonly platform: string;
  /** 这条通道握手推出来的 6 位校验码。 */
  readonly sas: string;
}

export type DeviceEvent =
  | {
      readonly type: "devices.pending";
      readonly pendingId: string;
      readonly deviceId: string;
      readonly label: string;
      readonly platform: string;
    }
  | { readonly type: "devices.changed"; readonly deviceId: string };

export class DeviceError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "sas_mismatch"
      | "sas_expired"
      | "device_limit"
      | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "DeviceError";
  }
}

export interface DeviceRegistryOptions {
  readonly store: TrustedDeviceStore;
  readonly now?: () => number;
  /** 事件流（`devices.pending` / `devices.changed`）。 */
  readonly emit?: (event: DeviceEvent) => void;
  /** 撤销或拒绝之后：断开这把钥的通道。 */
  readonly disconnect?: (deviceId: string) => void;
  /** 吊销了会话之后（断开长连接）。 */
  readonly accessChanged?: () => void;
}

/** 校验码保留多久（同一条通道一般远短于此）。 */
const SAS_TTL_MS = 30 * 60_000;

type Waiter = (status: DeviceStatus) => void;

export class DeviceRegistry {
  private readonly now: () => number;
  /** requestId → 最近一条通道的校验码。 */
  private readonly sas = new Map<string, { sas: string; atMs: number }>();
  private readonly waiters = new Map<string, Set<Waiter>>();

  constructor(private readonly options: DeviceRegistryOptions) {
    this.now = options.now ?? Date.now;
  }

  get store(): TrustedDeviceStore {
    return this.options.store;
  }

  /**
   * 通道刚建好时报给客户端的设备状态（握手 r0）：有任何一行 trusted 就是
   * `trusted`；所有行都被拒或撤销是 `rejected`；其余（没见过、待确认）`pending`。
   */
  channelStatus(deviceId: string): "trusted" | "pending" | "rejected" {
    const rows = this.options.store.forDevice(deviceId);
    if (rows.some((row) => row.status === "trusted")) return "trusted";
    if (
      rows.length > 0 &&
      rows.every((row) => row.status === "rejected" || row.status === "revoked")
    )
      return "rejected";
    return "pending";
  }

  /** 这把钥对这个主体是否已信任（已有会话的请求每次都问）。 */
  trusted(deviceId: string, principalId: string): boolean {
    return this.options.store.get(deviceId, principalId)?.status === "trusted";
  }

  /**
   * 以 `principalId` 登录时的设备关：已信任 → 记一次「最近」；`approvedBy` 给了
   * （配对、背书、访客链接已经证明过）→ 直接信任；被拒或撤销 → `rejected`；
   * 其余建 / 续待确认行并登记这条通道的校验码。
   */
  admit(input: {
    readonly device: ChannelDevice;
    readonly principalId: string;
    readonly issuer: string;
    readonly issuerDeviceId: string;
    readonly approvedBy?: string;
    /** 同一个 `approvedBy` 最多几台（访客链接的名额）；`null` / 不给 = 不限。 */
    readonly maxDevices?: number | null;
  }): DeviceVerdict {
    const { store } = this.options;
    const { device, principalId } = input;
    const at = this.now();
    const existing = store.get(device.deviceId, principalId);
    if (existing !== undefined) {
      if (!Buffer.from(device.publicKey).equals(existing.publicKey)) {
        // 设备 id 是公钥的摘要：对不上只能是碰撞或伪造。
        return { status: "rejected" };
      }
      if (existing.status === "trusted") {
        store.touch(device.deviceId, principalId, at);
        return { status: "trusted", approvedBy: existing.approvedBy };
      }
      if (existing.status === "rejected" || existing.status === "revoked")
        return { status: "rejected" };
    }
    if (input.approvedBy !== undefined) {
      if (
        input.maxDevices !== undefined &&
        input.maxDevices !== null &&
        existing?.approvedBy !== input.approvedBy &&
        store.countApprovedBy(input.approvedBy) >= input.maxDevices
      ) {
        throw new DeviceError("device_limit", "这个链接的设备数已经用完");
      }
      if (existing === undefined) {
        store.insert({
          deviceId: device.deviceId,
          principalId,
          publicKey: Buffer.from(device.publicKey),
          label: device.label,
          platform: device.platform,
          status: "trusted",
          requestId: randomBytes(16).toString("hex"),
          approvedBy: input.approvedBy,
          issuer: input.issuer,
          issuerDeviceId: input.issuerDeviceId,
          createdAtMs: at,
          approvedAtMs: at,
          lastSeenAtMs: at,
          revokedAtMs: 0,
        });
      } else {
        store.setStatus(device.deviceId, principalId, "trusted", {
          approvedBy: input.approvedBy,
          atMs: at,
        });
        this.wake(existing.requestId, "trusted");
      }
      this.options.emit?.({
        type: "devices.changed",
        deviceId: device.deviceId,
      });
      return { status: "trusted", approvedBy: input.approvedBy };
    }
    const requestId = randomBytes(16).toString("hex");
    if (existing === undefined) {
      store.insert({
        deviceId: device.deviceId,
        principalId,
        publicKey: Buffer.from(device.publicKey),
        label: device.label,
        platform: device.platform,
        status: "pending",
        requestId,
        approvedBy: "",
        issuer: input.issuer,
        issuerDeviceId: input.issuerDeviceId,
        createdAtMs: at,
        approvedAtMs: 0,
        lastSeenAtMs: at,
        revokedAtMs: 0,
      });
    } else {
      this.sas.delete(existing.requestId);
      store.repend(device.deviceId, principalId, {
        requestId,
        label: device.label,
        platform: device.platform,
      });
    }
    this.sas.set(requestId, { sas: device.sas, atMs: at });
    this.prune(at);
    this.options.emit?.({
      type: "devices.pending",
      pendingId: requestId,
      deviceId: device.deviceId,
      label: device.label,
      platform: device.platform,
    });
    return { status: "pending", requestId };
  }

  /** 主人核对校验码后放行。 */
  approve(requestId: string, sas: string): TrustedDeviceRow {
    const row = this.pendingRow(requestId);
    const known = this.sas.get(requestId);
    if (known === undefined || this.now() - known.atMs > SAS_TTL_MS) {
      throw new DeviceError("sas_expired", "这台设备需要重新连接一次");
    }
    if (known.sas !== sas.replace(/\s+/g, "")) {
      throw new DeviceError("sas_mismatch", "校验码不一致");
    }
    this.sas.delete(requestId);
    this.options.store.setStatus(row.deviceId, row.principalId, "trusted", {
      approvedBy: "local",
      atMs: this.now(),
    });
    this.changed(row.deviceId);
    this.wake(requestId, "trusted");
    return { ...this.options.store.get(row.deviceId, row.principalId)! };
  }

  reject(requestId: string): void {
    const row = this.pendingRow(requestId);
    this.sas.delete(requestId);
    this.options.store.setStatus(row.deviceId, row.principalId, "rejected", {
      atMs: this.now(),
    });
    this.changed(row.deviceId);
    this.wake(requestId, "rejected");
    this.options.disconnect?.(row.deviceId);
  }

  /** 撤销一行：吊销经它签的会话、断它的通道。 */
  revoke(deviceId: string, principalId: string): void {
    const { store } = this.options;
    const row = store.get(deviceId, principalId);
    if (row === undefined) throw new DeviceError("not_found", "没有这台设备");
    const at = this.now();
    store.setStatus(deviceId, principalId, "revoked", { atMs: at });
    if (store.revokeSessions(deviceId, principalId, at) > 0)
      this.options.accessChanged?.();
    this.sas.delete(row.requestId);
    this.wake(row.requestId, "revoked");
    this.changed(deviceId);
    this.options.disconnect?.(deviceId);
  }

  /** 撤销某个来路（访客链接）的全部设备；答撤了几台。 */
  revokeApprovedBy(approvedBy: string): number {
    let count = 0;
    for (const row of this.options.store.list()) {
      if (row.approvedBy !== approvedBy || row.status === "revoked") continue;
      this.revoke(row.deviceId, row.principalId);
      count += 1;
    }
    return count;
  }

  /** 删掉一行（被拒或撤销之后让它重新申请）；先撤销再删。 */
  forget(deviceId: string, principalId: string): void {
    const { store } = this.options;
    const row = store.get(deviceId, principalId);
    if (row === undefined) throw new DeviceError("not_found", "没有这台设备");
    if (row.status === "trusted" || row.status === "pending")
      this.revoke(deviceId, principalId);
    store.remove(deviceId, principalId);
    this.changed(deviceId);
  }

  rename(deviceId: string, principalId: string, label: string): void {
    if (!this.options.store.rename(deviceId, principalId, label))
      throw new DeviceError("not_found", "没有这台设备");
    this.changed(deviceId);
  }

  list(): DeviceView[] {
    return this.options.store.list();
  }

  /**
   * 新设备等主人核对：状态变了（或超时）就答当前状态。只认这把钥自己的待确认
   * 记录——别的设备拿到 requestId 也问不出东西。
   */
  async wait(
    requestId: string,
    deviceId: string,
    timeoutMs: number,
  ): Promise<DeviceStatus> {
    const row = this.options.store.byRequest(requestId);
    if (row === undefined || row.deviceId !== deviceId)
      throw new DeviceError("not_found", "没有这条待确认记录");
    if (row.status !== "pending") return row.status;
    return new Promise<DeviceStatus>((resolve) => {
      const set = this.waiters.get(requestId) ?? new Set<Waiter>();
      this.waiters.set(requestId, set);
      const timer = setTimeout(() => {
        set.delete(done);
        if (set.size === 0) this.waiters.delete(requestId);
        resolve("pending");
      }, timeoutMs);
      timer.unref?.();
      const done: Waiter = (status) => {
        clearTimeout(timer);
        resolve(status);
      };
      set.add(done);
    });
  }

  private pendingRow(requestId: string): TrustedDeviceRow {
    const row = this.options.store.byRequest(requestId);
    if (row === undefined || row.status !== "pending")
      throw new DeviceError("not_found", "没有这条待确认记录");
    return row;
  }

  private changed(deviceId: string): void {
    this.options.emit?.({ type: "devices.changed", deviceId });
  }

  private wake(requestId: string, status: DeviceStatus): void {
    const set = this.waiters.get(requestId);
    if (set === undefined) return;
    this.waiters.delete(requestId);
    for (const waiter of set) waiter(status);
  }

  private prune(at: number): void {
    for (const [id, entry] of this.sas) {
      if (at - entry.atMs > SAS_TTL_MS) this.sas.delete(id);
    }
  }
}

/**
 * 经通道登录时的设备关（契约 §77.1）：已信任答设备 id；待确认抛
 * `403 device_pending { pendingId }`；被拒、撤销或没有设备登记抛 `403 device_rejected`。
 */
export function requireTrustedDevice(
  registry: DeviceRegistry | undefined,
  input: Parameters<DeviceRegistry["admit"]>[0],
): string {
  if (registry === undefined) {
    throw fail("device_rejected", "这台电脑没有设备登记");
  }
  const verdict = registry.admit(input);
  if (verdict.status === "pending") {
    throw fail("device_pending", "等这台电脑的主人核对校验码", {
      pendingId: verdict.requestId,
    });
  }
  if (verdict.status === "rejected") {
    throw fail("device_rejected", "这台电脑的主人没有允许这台设备");
  }
  return input.device.deviceId;
}
