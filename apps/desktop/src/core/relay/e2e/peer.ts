/**
 * 端到端通道对端（客户端设备）在 core 里的样子，与这一轮装好的设备登记。
 *
 * 放在一个不 import 任何东西的叶子模块里：准入（`relay/admission.ts`）与云登录
 * （`identity/cloud/login.ts`）都要读它，而它们彼此已经互相依赖着装配顺序。
 */

import type { DeviceRegistry } from "./devices";
import type { PairingSecrets, ShareLinkStore } from "./pairing";

/** 握手 m3 里客户端证明了的东西；通道上每条内层流都带着它。 */
export interface ChannelPeer {
  /** 设备钥公钥 SHA-256 的前 16 字节（32 位十六进制）。 */
  readonly deviceId: string;
  readonly publicKey: Uint8Array;
  readonly label: string;
  readonly platform: string;
  /** 握手推出来的 6 位校验码（新设备屏幕上显示的那个）。 */
  readonly sas: string;
  /**
   * m3 的 `proof`（配对秘密或访客邀请令牌对转录的 HMAC，契约 §79）；首次以外没有。
   * 核对它要知道秘密，由用到它的那一步（配对、访客登录）自己核。
   */
  readonly proof?: Uint8Array;
  /** 用秘密核对 `proof`（HKDF(secret, proof 标签) 对转录的 HMAC）。 */
  readonly verifyProof?: (secret: Uint8Array) => Promise<boolean>;
  /** 这条通道的标识（撤销时断开用）。 */
  readonly channelId: number;
}

/** 通道建的内层流；只有登记过的才认（防止别的对象带同名字段冒充）。 */
const CHANNEL_SOCKETS = new WeakSet<object>();

/**
 * 一条连接（`request.raw.socket`）背后的通道对端：经端到端通道的内层流才有。
 * 内层流是 `TunnelDuplex`，它的 `tunnel.channel` 由通道在建流时填，外面改不了。
 */
export function channelPeerOf(socket: unknown): ChannelPeer | undefined {
  if (typeof socket !== "object" || socket === null) return undefined;
  if (!CHANNEL_SOCKETS.has(socket)) return undefined;
  return (socket as { tunnel?: { channel?: ChannelPeer } }).tunnel?.channel;
}

export function markChannelSocket(socket: object): void {
  CHANNEL_SOCKETS.add(socket);
}

let devices: DeviceRegistry | undefined;

/** 这一轮 core 的设备登记；中继没装（库没过统一迁移）时 `undefined`。 */
export function e2eDevices(): DeviceRegistry | undefined {
  return devices;
}

export function setE2eDevices(registry: DeviceRegistry | undefined): void {
  devices = registry;
}

let pairing: PairingSecrets | undefined;
let links: ShareLinkStore | undefined;

/** 配对秘密与分享链接记录（契约 §80）；中继没装时 `undefined`。 */
export function e2ePairing(): PairingSecrets | undefined {
  return pairing;
}

export function e2eShareLinks(): ShareLinkStore | undefined {
  return links;
}

export function setE2ePairing(
  next: { pairing: PairingSecrets; links: ShareLinkStore } | undefined,
): void {
  pairing = next?.pairing;
  links = next?.links;
}
