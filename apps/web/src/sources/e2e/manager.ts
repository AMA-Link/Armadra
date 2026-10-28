import { identityFingerprint } from "@armadra/platform-protocol/e2e";
import {
  E2eChannelError,
  E2eClientChannel,
  channelFetch,
  channelWebSocket,
  relayRefusal,
} from "@armadra/shared/e2e";

import { type DeviceIdentity, deviceIdentity } from "./device-key";
import { type PairingStore, storagePairings } from "./pairing";
import { type PinStore, storagePins } from "./pins";

/**
 * 页面这一侧的端到端通道管理（设计 §4、契约 §78）：一个源一条通道，所有请求与流
 * 复用它；断了、到了 1 小时、中继令牌换了都按需重建。
 *
 * - 钉扎：第一次连上记下 core 的身份公钥（或用配对、访客链接给的），之后变了就拒绝
 *   （`identity_changed`），不退回明文。
 * - 不退回明文：中继不再转发明文的应用请求（cloud 0.5.0），源不报 `e2e` 能力（旧
 *   core）答 `unsupported`（界面说「这台电脑需要升级」），这个环境没有 WebCrypto
 *   的 Ed25519 / X25519（旧 WebView）答 `device_unavailable`（界面请人用 App）。
 * - 待确认：登录答 `device_pending` 时，{@link E2eChannels.awaitApproval} 把校验码交给
 *   界面（{@link pendingApprovals}），经通道长轮询 `e2e.wait`，主人在本机核对后继续。
 */

export interface ChannelTarget {
  readonly issuer: string;
  readonly sourceId: string;
  /** 中继给的源基址（`https://<中继>/s/<sourceId>` 或 saas 子域）。 */
  readonly base: string;
  readonly relayToken: string;
  /** 界面上这台电脑的名字（待确认对话框用）。 */
  readonly label?: string;
  /** 首次配对的秘密 / 访客邀请令牌（字节）：有就在 m3 里带 `proof`。 */
  readonly proofSecret?: Uint8Array;
  /** 配对二维码 / 访客链接给的身份公钥（不走 TOFU）。 */
  readonly identityPub?: Uint8Array;
  /** 访客链接片段给的身份指纹前缀（契约 §80）：对不上就拒绝。 */
  readonly fingerprintPrefix?: string;
}

export class E2eAccessError extends Error {
  constructor(
    readonly code:
      | "identity_changed"
      | "device_rejected"
      | "device_unavailable"
      | "unsupported"
      | "unreachable"
      /** 中继说这台电脑不在线（隧道断了、对端重启）：等它回来。 */
      | "offline"
      | "cancelled",
    message: string = code,
  ) {
    super(message);
    this.name = "E2eAccessError";
  }
}

/* ------------------------------- 待确认（界面） ------------------------------- */

export interface PendingApproval {
  readonly sourceId: string;
  readonly label: string;
  /** 新设备屏幕上显示的 6 位校验码。 */
  readonly sas: string;
  readonly status: "waiting" | "rejected";
  cancel(): void;
}

type Listener = () => void;
let approvals: readonly PendingApproval[] = [];
const listeners = new Set<Listener>();

function publish(next: readonly PendingApproval[]): void {
  approvals = next;
  for (const listener of [...listeners]) listener();
}

/** 交一条待确认给界面（同一个源的旧的被替换）。 */
export function showPendingApproval(
  entry: Omit<PendingApproval, "status">,
): void {
  publish([
    ...approvals.filter((one) => one.sourceId !== entry.sourceId),
    { ...entry, status: "waiting" },
  ]);
}

export function markApprovalRejected(sourceId: string): void {
  publish(
    approvals.map((one) =>
      one.sourceId === sourceId ? { ...one, status: "rejected" } : one,
    ),
  );
}

export function dismissPendingApproval(sourceId: string): void {
  publish(approvals.filter((one) => one.sourceId !== sourceId));
}

/** 待确认对话框按空间加的一行「谁能放行」（控制台 `/h/` 知道主机在哪个空间时给）。 */
export type ApprovalHint = "team" | "personal";
const hints = new Map<string, ApprovalHint>();

export function setApprovalHint(sourceId: string, hint: ApprovalHint): void {
  hints.set(sourceId, hint);
}

export function approvalHint(sourceId: string): ApprovalHint | null {
  return hints.get(sourceId) ?? null;
}

/** 正在等主人核对的设备（`useSyncExternalStore` 用）。 */
export const pendingApprovals = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  snapshot(): readonly PendingApproval[] {
    return approvals;
  },
  dismiss(sourceId: string): void {
    publish(approvals.filter((one) => one.sourceId !== sourceId));
  },
};

/* --------------------------------- 管理 --------------------------------- */

export interface E2eChannelsOptions {
  readonly pins?: PinStore;
  /** 扫到的配对二维码（契约 §80.1）。 */
  readonly pairings?: PairingStore;
  readonly device?: () => Promise<DeviceIdentity>;
  /** 设备在远程服务里的名字（m3 的 `name`）。 */
  readonly deviceName: () => string;
  readonly WebSocket?: typeof WebSocket;
  /** 等候一次之间的最短间隔（毫秒），测试缩短。 */
  readonly waitRetryMs?: number;
}

function wsUrl(base: string): string {
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/_relay/e2e`;
  url.search = "";
  url.hash = "";
  return url.href;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

export class E2eChannels {
  private readonly open = new Map<string, E2eClientChannel>();
  private readonly opening = new Map<string, Promise<E2eClientChannel>>();
  private readonly fetches = new WeakMap<E2eClientChannel, typeof fetch>();
  private readonly sockets = new WeakMap<E2eClientChannel, typeof WebSocket>();
  private readonly pins: PinStore;
  private readonly pairings: PairingStore;

  constructor(private readonly options: E2eChannelsOptions) {
    this.pins = options.pins ?? storagePins();
    this.pairings = options.pairings ?? storagePairings();
  }

  /** 这个源钉过身份（建成过通道）。 */
  pinned(issuer: string, sourceId: string): boolean {
    return this.pins.get(issuer, sourceId) !== null;
  }

  /** 人在设置里「忘记」这台电脑的身份：下次重新 TOFU。 */
  forget(issuer: string, sourceId: string): void {
    this.pins.forget(issuer, sourceId);
    this.close(issuer, sourceId);
  }

  close(issuer: string, sourceId: string): void {
    const name = `${issuer}\u0000${sourceId}`;
    this.open.get(name)?.close();
    this.open.delete(name);
  }

  /**
   * 这个源的通道：开着就复用，没有就建。答 `null` = 源不支持（过渡期，调用方走
   * 明文）；身份变了抛 `identity_changed`。
   */
  channel(target: ChannelTarget): Promise<E2eClientChannel> {
    const name = `${target.issuer}\u0000${target.sourceId}`;
    const current = this.open.get(name);
    if (current !== undefined && !current.closed && !current.expired)
      return Promise.resolve(current);
    if (current !== undefined) {
      current.close();
      this.open.delete(name);
    }
    let inflight = this.opening.get(name);
    if (inflight === undefined) {
      inflight = this.connect(target)
        .then((channel) => {
          if (channel !== null) {
            this.open.set(name, channel);
            channel.onClose(() => {
              if (this.open.get(name) === channel) this.open.delete(name);
            });
          }
          return channel;
        })
        .finally(() => this.opening.delete(name));
      this.opening.set(name, inflight);
    }
    return inflight;
  }

  private async connect(target: ChannelTarget): Promise<E2eClientChannel> {
    let identity: DeviceIdentity;
    try {
      identity = await (this.options.device ?? deviceIdentity)();
    } catch {
      // 这个环境没有 Ed25519（旧 WebView）或设备钥取不到。
      throw new E2eAccessError("device_unavailable");
    }
    // 扫过这台电脑的配对二维码：身份不走 TOFU，握手带 proof（用过即删）。
    const offer =
      target.proofSecret === undefined
        ? this.pairings.get(target.sourceId)
        : null;
    const proofSecret = target.proofSecret ?? offer?.secret;
    const pinned =
      target.identityPub ??
      offer?.identityPub ??
      this.pins.get(target.issuer, target.sourceId);
    let channel: E2eClientChannel;
    try {
      channel = await E2eClientChannel.open({
        url: wsUrl(target.base),
        relayToken: target.relayToken,
        sourceId: target.sourceId,
        device: identity.signer,
        platform: identity.platform,
        name: this.options.deviceName(),
        pinned,
        ...(proofSecret === undefined ? {} : { proofSecret }),
        ...(this.options.WebSocket === undefined
          ? {}
          : { WebSocket: this.options.WebSocket }),
      });
    } catch (error) {
      if (
        error instanceof E2eChannelError &&
        error.code === "identity_mismatch"
      )
        throw new E2eAccessError("identity_changed");
      // 中继答源不支持（4404 `e2e_unsupported`）或不认版本（4409）：旧 core；
      // 其余 4404 是源不在线。
      const refusal = relayRefusal(error);
      if (refusal === "unsupported") throw new E2eAccessError("unsupported");
      if (refusal === "offline") throw new E2eAccessError("offline");
      throw new E2eAccessError("unreachable");
    }
    if (
      target.fingerprintPrefix !== undefined &&
      !(await identityFingerprint(channel.coreIdentity)).startsWith(
        target.fingerprintPrefix,
      )
    ) {
      channel.close();
      throw new E2eAccessError("identity_changed");
    }
    if (pinned === null) {
      this.pins.set(target.issuer, target.sourceId, channel.coreIdentity);
    } else if (!same(pinned, channel.coreIdentity)) {
      channel.close();
      throw new E2eAccessError("identity_changed");
    }
    if (target.identityPub !== undefined || offer !== null)
      this.pins.set(target.issuer, target.sourceId, channel.coreIdentity);
    if (offer !== null) this.pairings.consume(target.sourceId);
    return channel;
  }

  /** 发往这个源（`base` 下）的 `fetch`，字节走通道。 */
  fetchFor(channel: E2eClientChannel, base: string): typeof fetch {
    let found = this.fetches.get(channel);
    if (found === undefined) {
      found = channelFetch(channel, { origin: null, base });
      this.fetches.set(channel, found);
    }
    return found;
  }

  /** 发往这个源的 `WebSocket` 类，字节走通道。 */
  socketFor(channel: E2eClientChannel, base: string): typeof WebSocket {
    let found = this.sockets.get(channel);
    if (found === undefined) {
      found = channelWebSocket(channel, { origin: null, base });
      this.sockets.set(channel, found);
    }
    return found;
  }

  /**
   * 登录答了 `device_pending`：把校验码交给界面，经通道等主人核对。答 `true` = 已
   * 允许（调用方重新登录）；被拒抛 `device_rejected`，人取消抛 `cancelled`。
   */
  async awaitApproval(
    target: ChannelTarget,
    channel: E2eClientChannel,
    pendingId: string,
  ): Promise<true> {
    const fetcher = this.fetchFor(channel, target.base);
    let cancelled = false;
    let abort: AbortController | null = null;
    const entry: PendingApproval = {
      sourceId: target.sourceId,
      label: target.label ?? "",
      sas: channel.sas,
      status: "waiting",
      cancel: () => {
        cancelled = true;
        abort?.abort();
        pendingApprovals.dismiss(target.sourceId);
      },
    };
    publish([
      ...approvals.filter((one) => one.sourceId !== target.sourceId),
      entry,
    ]);
    try {
      for (;;) {
        if (cancelled) throw new E2eAccessError("cancelled");
        if (channel.closed) throw new E2eAccessError("cancelled");
        abort = new AbortController();
        let status = "pending";
        try {
          const response = await fetcher(
            `${target.base.replace(/\/+$/, "")}/api/e2e/wait`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ pendingId }),
              signal: abort.signal,
            },
          );
          if (response.ok)
            status =
              ((await response.json()) as { status?: string }).status ??
              "pending";
          else if (response.status === 404) status = "rejected";
        } catch {
          if (cancelled) throw new E2eAccessError("cancelled");
          await new Promise((resolve) =>
            setTimeout(resolve, this.options.waitRetryMs ?? 2_000),
          );
        }
        if (status === "trusted") {
          pendingApprovals.dismiss(target.sourceId);
          return true;
        }
        if (status === "rejected" || status === "revoked") {
          publish(
            approvals.map((one) =>
              one === entry ? { ...entry, status: "rejected" } : one,
            ),
          );
          throw new E2eAccessError("device_rejected");
        }
      }
    } catch (error) {
      if (
        !(error instanceof E2eAccessError && error.code === "device_rejected")
      )
        pendingApprovals.dismiss(target.sourceId);
      throw error;
    }
  }
}

let shared: E2eChannels | null = null;

/** 这一页的通道管理（一页一份）。 */
export function e2eChannels(deviceName: () => string): E2eChannels {
  shared ??= new E2eChannels({ deviceName });
  return shared;
}

/** 测试用。 */
export function resetE2eChannels(): void {
  shared = null;
  publish([]);
}

/**
 * 第一次经访客链接加入（契约 §80）：先开通道（邀请令牌作 proof、链接里的指纹钉身份），
 * 源 core 的 `cloud/login` 走它。答给 `coreCloudLogin` 的选项。
 */
export async function sealedJoinOptions<T extends { fetch?: typeof fetch }>(
  channels: E2eChannels | undefined,
  base: T | undefined,
  target: Omit<ChannelTarget, "proofSecret"> & {
    readonly invitationToken: string;
  },
): Promise<T & { fetch: typeof fetch }> {
  if (channels === undefined) throw new E2eAccessError("device_unavailable");
  const { invitationToken, ...rest } = target;
  const channel = await channels.channel({
    ...rest,
    proofSecret: new TextEncoder().encode(invitationToken),
  });
  return {
    ...(base ?? ({} as T)),
    fetch: channels.fetchFor(channel, target.base),
  };
}

/**
 * 访客要钉的身份指纹前缀：链接片段第三段（core 自己给的）优先；旧链接没有时退到中继
 * `links.accept` 报的指纹前 16 位（只是提示，好过完全 TOFU）。都没有是 `undefined`。
 */
export function fingerprintPrefix(
  fromLink: string | undefined,
  fromRelay: string | undefined,
): string | undefined {
  if (fromLink !== undefined && fromLink !== "") return fromLink;
  if (fromRelay !== undefined && /^[a-z2-7]{16,}$/.test(fromRelay))
    return fromRelay.slice(0, 16);
  return undefined;
}
