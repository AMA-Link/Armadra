/**
 * 本机作为客户端经中继连别的电脑时的端到端通道（契约 §78，设计 §4.12「桌面
 * Electron」）：`sources` 域代页面登录、刷新的那几个请求（`cloud/login`、
 * `session/refresh`）走通道，会话因此绑本机的设备钥（`armadra-device-key`）；
 * 页面之后经 `e2e.sign` 用同一把钥开自己的通道，用这份会话。
 *
 * 客户端实现是页面那一份（`@armadra/shared/e2e`），底层 WebSocket 用 `ws`，个人中转
 * 自签证书时按远程服务的 CA 指纹钉扎。对端身份公钥钉在源表（`client_sources.
 * identity_pub`）：第一次记下，之后变了拒绝。
 *
 * 没有明文退路：连不上答 `source_unreachable`；中继说对端没有通道（旧 core，关闭码
 * 4409，或 4404 且原因 `e2e_unsupported`）答 `e2e_unsupported`，对端不在线（4404 其余）答
 * `source_offline`。
 */

import {
  type DevicePlatform,
  E2eChannelError,
  E2eClientChannel,
  channelFetch,
  relayRefusal,
} from "@armadra/shared/e2e";
import { identityFingerprint } from "@armadra/platform-protocol/e2e";
import { WebSocket as Ws } from "ws";

import { fail } from "../../http/errors";
import type {
  OutboundAnswer,
  OutboundRequest,
} from "../../sources/http-client";
import type { DeviceKey } from "./device-key";

export interface OutboundTarget {
  readonly sourceId: string;
  /** 中继给的源基址（`https://<中继>/s/<sourceId>`）。 */
  readonly base: string;
  readonly relayToken: string;
  /** 中继的 CA 指纹（个人中转自签）；空 = 系统信任。 */
  readonly fingerprint: string;
  /** 第一次经访客链接加入时的邀请令牌（m3 的 `proof`，契约 §80）。 */
  readonly proofSecret?: Uint8Array;
  /** 链接片段给出的对端身份指纹前缀：对不上就拒绝，不走 TOFU。 */
  readonly identityFp?: string;
}

export interface OutboundPins {
  get(sourceId: string): Uint8Array | null;
  set(sourceId: string, identityPub: Uint8Array): void;
}

export interface OutboundChannelsOptions {
  readonly deviceKey: DeviceKey;
  readonly pins: OutboundPins;
  /** m3 的设备名（远程那台的设备列表里显示）。 */
  readonly name: () => string;
  /** 按指纹取 CA（`sources/http-client.ts::pinnedAnchor`）。 */
  readonly anchor: (
    url: string,
    fingerprint: string,
  ) => Promise<string | undefined>;
  readonly platform?: DevicePlatform;
}

function wsUrl(base: string): string {
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/_relay/e2e`;
  url.search = "";
  return url.href;
}

/** `ws` 的一个子类：构造器是浏览器的形状，另带钉扎的 CA。 */
function pinnedSocket(ca: string | undefined): typeof WebSocket {
  class PinnedSocket extends Ws {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols, {
        perMessageDeflate: false,
        ...(ca === undefined ? {} : { ca }),
      });
    }
  }
  return PinnedSocket as unknown as typeof WebSocket;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

export class OutboundChannels {
  private readonly open = new Map<string, E2eClientChannel>();
  private readonly opening = new Map<string, Promise<E2eClientChannel>>();

  constructor(private readonly options: OutboundChannelsOptions) {}

  /** 这个源开着的通道（等候用）；没有是 `undefined`。 */
  current(sourceId: string): E2eClientChannel | undefined {
    const found = this.open.get(sourceId);
    return found === undefined || found.closed ? undefined : found;
  }

  channel(target: OutboundTarget): Promise<E2eClientChannel> {
    const existing = this.current(target.sourceId);
    if (existing !== undefined && !existing.expired)
      return Promise.resolve(existing);
    existing?.close();
    let inflight = this.opening.get(target.sourceId);
    if (inflight === undefined) {
      inflight = this.connect(target)
        .then((channel) => {
          this.open.set(target.sourceId, channel);
          channel.onClose(() => {
            if (this.open.get(target.sourceId) === channel)
              this.open.delete(target.sourceId);
          });
          return channel;
        })
        .finally(() => this.opening.delete(target.sourceId));
      this.opening.set(target.sourceId, inflight);
    }
    return inflight;
  }

  private async connect(target: OutboundTarget): Promise<E2eClientChannel> {
    const pinned = this.options.pins.get(target.sourceId);
    const url = wsUrl(target.base);
    let channel: E2eClientChannel;
    try {
      const ca =
        target.fingerprint === ""
          ? undefined
          : await this.options.anchor(target.base, target.fingerprint);
      channel = await E2eClientChannel.open({
        url,
        relayToken: target.relayToken,
        sourceId: target.sourceId,
        device: await this.options.deviceKey.signer(),
        platform: this.options.platform ?? "desktop",
        name: this.options.name(),
        pinned,
        WebSocket: pinnedSocket(ca),
        ...(target.proofSecret === undefined
          ? {}
          : { proofSecret: target.proofSecret }),
      });
    } catch (error) {
      if (
        error instanceof E2eChannelError &&
        error.code === "identity_mismatch"
      )
        throw fail("identity_changed", "这台电脑的身份变了");
      const refusal = relayRefusal(error);
      if (refusal === "unsupported")
        throw fail("e2e_unsupported", "这台电脑没有端到端通道，需要升级");
      if (refusal === "offline")
        throw fail("source_offline", "这台机器当前不在线");
      throw fail("source_unreachable", "连不上这台电脑的端到端通道");
    }
    if (
      target.identityFp !== undefined &&
      !(await identityFingerprint(channel.coreIdentity)).startsWith(
        target.identityFp,
      )
    ) {
      channel.close();
      throw fail("identity_changed", "这台电脑的身份与链接里的不符");
    }
    if (pinned === null) {
      this.options.pins.set(target.sourceId, channel.coreIdentity);
    } else if (!same(pinned, channel.coreIdentity)) {
      channel.close();
      throw fail("identity_changed", "这台电脑的身份变了");
    }
    return channel;
  }

  /**
   * 经通道发一个 JSON 请求（`sources/http-client.ts` 的 `Transport` 形状）。
   */
  async request(
    target: OutboundTarget,
    request: OutboundRequest,
  ): Promise<{ answer: OutboundAnswer; sas: string }> {
    const channel = await this.channel(target);
    const fetcher = channelFetch(channel, { origin: null, base: target.base });
    const headers: Record<string, string> = { ...request.headers };
    delete headers["armadra-relay-token"];
    if (request.body !== undefined)
      headers["content-type"] = "application/json";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    timer.unref?.();
    try {
      const response = await fetcher(request.url, {
        method: request.method,
        headers,
        ...(request.body === undefined
          ? {}
          : { body: JSON.stringify(request.body) }),
        signal: controller.signal,
      });
      const text = await response.text();
      let body: unknown;
      try {
        body = text === "" ? undefined : JSON.parse(text);
      } catch {
        body = undefined;
      }
      return { answer: { status: response.status, body }, sas: channel.sas };
    } catch {
      throw fail("source_unreachable", "经端到端通道的请求没有完成");
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 这台设备在对端待确认时等主人核对（对端 `e2e.wait`，经开着的那条通道）。通道
   * 已经不在（校验码随之作废）答 `pending`，页面重新取会话即可。
   */
  async wait(
    sourceId: string,
    pendingId: string,
  ): Promise<"pending" | "trusted" | "rejected" | "revoked"> {
    const channel = this.current(sourceId);
    if (channel === undefined) return "pending";
    const fetcher = channelFetch(channel, { origin: null });
    try {
      // 通道里只用路径；主机名随便给一个合法的。
      const response = await fetcher("http://source.e2e/api/e2e/wait", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pendingId }),
      });
      if (response.status === 404) return "rejected";
      if (!response.ok) return "pending";
      const status = ((await response.json()) as { status?: unknown }).status;
      return status === "trusted" ||
        status === "rejected" ||
        status === "revoked"
        ? status
        : "pending";
    } catch {
      return "pending";
    }
  }

  close(): void {
    for (const channel of this.open.values()) channel.close();
    this.open.clear();
  }
}
