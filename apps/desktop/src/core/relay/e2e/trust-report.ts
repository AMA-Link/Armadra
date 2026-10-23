/**
 * 新设备待信任的上报（SaaS 云端契约 §31 的 core 一侧；Issue #482）。
 *
 * 团队成员的新设备停在 `device_pending` 时，向登记它的 SaaS 签发方
 * `POST <issuer>/v1/sources/me/trust-requests` 报一条，云端只负责把通知推给背书人；
 * 批准或过期后 `POST .../{pendingId}/resolve`。`Authorization: Source <jws>`，同
 * `sources.heartbeatHint`。
 *
 * - 上报内容只有 `{ pendingId, accountId, deviceId, expiresAtMs }`；校验码留在端到端
 *   通道里，云端看不到，这里也拿不到。
 * - 只上报 SaaS 登记（`mode = "saas"`）；个人中转不报。
 * - 网络失败与 5xx / 429 用有界退避重试，不阻塞本地流程（全程在后台，永不抛）；
 *   `rejected`（冷却期）、404、409、403、501 都是正常答复，不重试。
 * - 本地待确认条目换了 id（设备重连）、被批准、被拒、被撤销或过期，都收尾成
 *   `trusted` / `expired`；云端先过期或已拒时答 404 / 409，同样当作正常。
 */

import type { Transport } from "../../sources/http-client";
import type { DeviceEvent, DeviceStatus, TrustedDeviceRow } from "./devices";

/** 契约：`expiresAtMs` 至多比现在晚 24 小时。 */
export const MAX_TRUST_WINDOW_MS = 24 * 60 * 60_000;
/** 每条请求的重试次数上限（含首次）。 */
export const MAX_ATTEMPTS = 6;
const TIMEOUT_MS = 10_000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_CAP_MS = 60_000;

export interface TrustReporterOptions {
  readonly transport: Transport;
  readonly signSourceJws: (audience: string) => Promise<string>;
  readonly fingerprint: (issuer: string) => string;
  /** 这个 issuer 的登记类型；没有登记（或已撤销）是 `undefined`。 */
  readonly modeOf: (issuer: string) => "saas" | "personal" | undefined;
  /** 本地待确认条目现在的样子；找不到是 `undefined`。 */
  readonly lookup: (pendingId: string) => TrustedDeviceRow | undefined;
  readonly now?: () => number;
  /** 可换的定时器；返回取消函数。 */
  readonly schedule?: (run: () => void, ms: number) => () => void;
  readonly log?: {
    info(message: string, data?: Record<string, unknown>): void;
    warn(message: string, data?: Record<string, unknown>): void;
  };
}

interface Entry {
  readonly pendingId: string;
  readonly issuer: string;
  readonly accountId: string;
  /** 云端的设备 id（`issuerDeviceId`）。 */
  readonly deviceId: string;
  /** 本机设备登记里的设备 id。 */
  readonly localDeviceId: string;
  readonly principalId: string;
  readonly expiresAtMs: number;
  /** 串起这一条的请求与收尾，保证先报后收。 */
  chain: Promise<void>;
  resolved: boolean;
  /** 云端已登记过这条（请求得到 2xx 且不是 rejected）；没登记过就不必收尾。 */
  reported: boolean;
  cancelExpiry: () => void;
}

type Outcome = "done" | "retry" | "stop";

export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
}

export class TrustReporter {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly schedule: (run: () => void, ms: number) => () => void;
  private closed = false;

  constructor(private readonly options: TrustReporterOptions) {
    this.now = options.now ?? Date.now;
    this.schedule =
      options.schedule ??
      ((run, ms) => {
        const timer = setTimeout(run, ms);
        timer.unref?.();
        return () => clearTimeout(timer);
      });
  }

  /** 设备登记的事件：`devices.pending` 开一条上报，`devices.changed` 收尾已不再待确认的。 */
  handle(event: DeviceEvent): void {
    if (this.closed) return;
    if (event.type === "devices.pending") this.pending(event);
    else this.settle(event.deviceId);
  }

  /** 停掉所有定时与重试；还没收尾的不再报（云端到期自己会作废）。 */
  close(): void {
    this.closed = true;
    for (const entry of this.entries.values()) entry.cancelExpiry();
    this.entries.clear();
  }

  /** 等所有进行中的上报跑完（测试用）。 */
  async idle(): Promise<void> {
    while (this.tasks.size > 0) await Promise.allSettled([...this.tasks]);
  }

  private readonly tasks = new Set<Promise<void>>();

  private pending(event: Extract<DeviceEvent, { type: "devices.pending" }>) {
    if (this.options.modeOf(event.issuer) !== "saas") return;
    if (event.accountId === "" || event.issuerDeviceId === "") return;
    // 同一台设备重连会换 pendingId：旧的收尾成 expired。
    for (const old of [...this.entries.values()]) {
      if (
        old.localDeviceId === event.deviceId &&
        old.principalId === event.principalId &&
        old.pendingId !== event.pendingId
      ) {
        this.finish(old, "expired");
      }
    }
    if (this.entries.has(event.pendingId)) return;
    const at = this.now();
    const expiresAtMs = Math.min(event.expiresAtMs, at + MAX_TRUST_WINDOW_MS);
    const entry: Entry = {
      pendingId: event.pendingId,
      issuer: event.issuer,
      accountId: event.accountId,
      deviceId: event.issuerDeviceId,
      localDeviceId: event.deviceId,
      principalId: event.principalId,
      expiresAtMs,
      chain: Promise.resolve(),
      resolved: false,
      reported: false,
      cancelExpiry: () => undefined,
    };
    this.entries.set(entry.pendingId, entry);
    entry.cancelExpiry = this.schedule(
      () => this.settleEntry(entry, true),
      Math.max(0, expiresAtMs - at),
    );
    this.enqueue(entry, () =>
      this.send(entry, "request", `/v1/sources/me/trust-requests`, {
        pendingId: entry.pendingId,
        accountId: entry.accountId,
        deviceId: entry.deviceId,
        expiresAtMs: entry.expiresAtMs,
      }),
    );
  }

  private settle(deviceId: string): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.localDeviceId === deviceId) this.settleEntry(entry);
    }
  }

  /** `expired`：到期定时器触发，仍待确认的直接按 expired 收尾（不再比时钟）。 */
  private settleEntry(entry: Entry, expired = false): void {
    if (entry.resolved || this.closed) return;
    const row = this.options.lookup(entry.pendingId);
    const status: DeviceStatus | "gone" = row?.status ?? "gone";
    if (status === "pending" && !expired) return;
    this.finish(entry, status === "trusted" ? "trusted" : "expired");
  }

  private finish(entry: Entry, result: "trusted" | "expired"): void {
    if (entry.resolved) return;
    entry.resolved = true;
    entry.cancelExpiry();
    this.enqueue(entry, () =>
      this.send(
        entry,
        "resolve",
        `/v1/sources/me/trust-requests/${encodeURIComponent(entry.pendingId)}/resolve`,
        { result },
      ),
    ).finally(() => {
      if (this.entries.get(entry.pendingId) === entry)
        this.entries.delete(entry.pendingId);
    });
  }

  private enqueue(entry: Entry, run: () => Promise<void>): Promise<void> {
    const next = entry.chain.then(run);
    entry.chain = next;
    this.tasks.add(next);
    void next.finally(() => this.tasks.delete(next));
    return next;
  }

  private async send(
    entry: Entry,
    kind: "request" | "resolve",
    path: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (this.closed) return;
      // 旧条目晚到的重试不得在云端顶掉新条目；没登记过的条目也不必收尾（必然 404）。
      if (kind === "request" && entry.resolved) return;
      if (kind === "resolve" && !entry.reported) return;
      const outcome = await this.once(entry, kind, path, body);
      if (outcome !== "retry") return;
      if (attempt === MAX_ATTEMPTS) {
        this.options.log?.warn("待信任上报多次失败，放弃", {
          issuer: entry.issuer,
          kind,
        });
        return;
      }
      await new Promise<void>((resolve) => {
        this.schedule(() => resolve(), backoffMs(attempt));
      });
    }
  }

  private async once(
    entry: Entry,
    kind: "request" | "resolve",
    path: string,
    body: Record<string, unknown>,
  ): Promise<Outcome> {
    if (this.options.modeOf(entry.issuer) !== "saas") return "stop";
    let answer: { status: number; body: unknown };
    try {
      const jws = await this.options.signSourceJws(entry.issuer);
      answer = await this.options.transport({
        method: "POST",
        url: `${entry.issuer}${path}`,
        fingerprint: this.options.fingerprint(entry.issuer),
        timeoutMs: TIMEOUT_MS,
        headers: { authorization: `Source ${jws}` },
        body,
      });
    } catch {
      return "retry";
    }
    const { status } = answer;
    if (status >= 200 && status < 300) {
      if (kind === "request") {
        const state =
          typeof answer.body === "object" && answer.body !== null
            ? (answer.body as { status?: unknown }).status
            : undefined;
        // 冷却期内答 rejected 是正常情况：云端不再通知，不重试，也不必收尾。
        entry.reported = state !== "rejected";
        this.options.log?.info("新设备待信任已上报", {
          issuer: entry.issuer,
          status: typeof state === "string" ? state : "unknown",
        });
      }
      return "done";
    }
    if (status === 429 || status >= 500) {
      // 501：云端还没实现，等同不支持，不必重试。
      return status === 501 ? "stop" : "retry";
    }
    // 400 / 403 / 404 / 409 等：云端已作废、已拒绝或不认，重试没有意义。
    if (status === 400) {
      this.options.log?.warn("云端拒收待信任上报", { issuer: entry.issuer });
    }
    return "stop";
  }
}
