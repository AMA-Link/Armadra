import { ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js";
import { bytesToNumberLE, equalBytes } from "@noble/curves/utils.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { concatBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";

import { gatewayPairingPayloadSchema } from "./api/gateway.js";

/**
 * 配对码的口令认证密钥交换（契约 §73）：原生 App 第一次连一个还没钉过信任锚
 * 的 Gateway 时，用 8 位配对码认出对方、并认出对方发的那张证书。
 *
 * 结构是 CPace（ristretto255）：生成元由配对码与会话标识哈希到群上，双方各出
 * 一个随机标量，共享秘密只有知道同一枚码的两方算得出。确认标签把各自看到的
 * Gateway 来源与信任锚指纹绑进去：中间人换了证书，App 看到的指纹与 Gateway
 * 自己的不同，两边的标签就对不上。
 *
 *   * 被动窃听：线上只有群元素与 HMAC，拿不到可离线验证配对码的东西；
 *   * 冒充 App：每次 start 只能试一个码（Gateway 照常限流）；
 *   * 冒充 Gateway：每次让 App 失败一次，最多试 {@link PAIRING_PAKE_MAX_OFFERS}
 *     个码，且失败对人可见。
 *
 * 两端（core 与页面）用这同一份实现，线上格式见 schema。
 */

/** 域分隔串：换算法或格式就换版本号。 */
export const PAIRING_PAKE_DSI = "Armadra-PairingCode-CPace-ristretto255-v1";
/** 一次 start 最多答几个候选（同时活着的配对码上限，core `PAIRING_CODE_LIMIT`）。 */
export const PAIRING_PAKE_MAX_OFFERS = 32;
/** App 出的会话标识长度（字节）。 */
export const PAIRING_PAKE_SID_BYTES = 16;

const Point = ristretto255.Point;
const ORDER = Point.Fn.ORDER;
const ELEMENT_BYTES = 32;
const TAG_BYTES = 32;

/* --------------------------------- 编码 --------------------------------- */

/** 无填充的 base64url。 */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** 解不开或长度不对答 `null`。 */
export function fromBase64Url(
  text: string,
  length?: number,
): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  let binary: string;
  try {
    binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (length !== undefined && bytes.length !== length) return null;
  // 只认规范拼法：同一串字节只有一种写法。
  return toBase64Url(bytes) === text ? bytes : null;
}

/** 每段前缀两字节大端长度，拼接无歧义。 */
function lv(...parts: (Uint8Array | string)[]): Uint8Array {
  return concatBytes(
    ...parts.flatMap((part) => {
      const bytes = typeof part === "string" ? utf8ToBytes(part) : part;
      if (bytes.length > 0xffff) throw new Error("field too long");
      return [new Uint8Array([bytes.length >> 8, bytes.length & 0xff]), bytes];
    }),
  );
}

/* --------------------------------- 原语 --------------------------------- */

/** 人输进来的配对码 → 规范拼法（大写、去掉空白与连字符）。 */
export function normalizePairingCodeInput(input: string): string {
  return input.replace(/[\s-]/g, "").toUpperCase();
}

/** 指纹按小写十六进制、去掉冒号比。 */
export function normalizeFingerprint(input: string): string {
  return input.replace(/:/g, "").toLowerCase();
}

function generator(code: string, sid: Uint8Array) {
  return ristretto255_hasher.hashToCurve(
    lv(normalizePairingCodeInput(code), sid),
    { DST: PAIRING_PAKE_DSI },
  );
}

/** 生成元的编码（测试向量用：格式变了它就变）。 */
export function pakeGeneratorBytes(code: string, sid: Uint8Array): Uint8Array {
  return generator(code, sid).toBytes();
}

function randomScalar(): bigint {
  // 64 字节取模：偏差可以忽略（RFC 9380 hash_to_field 同一个做法）。
  for (;;) {
    const scalar = bytesToNumberLE(randomBytes(64)) % ORDER;
    if (scalar !== 0n) return scalar;
  }
}

export interface PakeShare {
  /** 这一方的随机标量；只在内存里，用完即弃。 */
  readonly secret: bigint;
  /** 发给对方的群元素（32 字节）。 */
  readonly share: Uint8Array;
}

/** 用一枚配对码与会话标识出这一方的那一份。 */
export function pakeShare(code: string, sid: Uint8Array): PakeShare {
  const secret = randomScalar();
  return { secret, share: generator(code, sid).multiply(secret).toBytes() };
}

/**
 * 共享的会话密钥 `ISK`。`initiator` 是 App 的那一份、`responder` 是 Gateway
 * 的，两边按同一个次序拼。对方的元素不是合法编码或是单位元答 `null`。
 */
export function pakeKey(input: {
  readonly secret: bigint;
  readonly peer: Uint8Array;
  readonly sid: Uint8Array;
  readonly initiator: Uint8Array;
  readonly responder: Uint8Array;
}): Uint8Array | null {
  if (input.peer.length !== ELEMENT_BYTES) return null;
  let peer;
  try {
    peer = Point.fromBytes(input.peer);
  } catch {
    return null;
  }
  if (peer.is0()) return null;
  const shared = peer.multiply(input.secret);
  if (shared.is0()) return null;
  return sha512(
    lv(
      `${PAIRING_PAKE_DSI}_ISK`,
      input.sid,
      shared.toBytes(),
      input.initiator,
      input.responder,
    ),
  );
}

/**
 * 确认标签：谁（`server` / `client`）、在哪个 Gateway 来源上、认的是哪张信任
 * 锚。两边各用自己看到的来源与指纹算。
 */
export function pakeConfirm(
  isk: Uint8Array,
  role: "server" | "client",
  origin: string,
  fingerprint: string,
): Uint8Array {
  return hmac(
    sha256,
    isk,
    lv(role, origin, normalizeFingerprint(fingerprint)),
  ).subarray(0, TAG_BYTES);
}

/** 常量时间比较两枚标签。 */
export function pakeConfirmEquals(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && equalBytes(a, b);
}

/** App 出的会话标识。 */
export function newPakeSid(): Uint8Array {
  return randomBytes(PAIRING_PAKE_SID_BYTES);
}

/* -------------------------------- 线上形状 -------------------------------- */

const b64 = (bytes: number) =>
  z.string().refine((value) => fromBase64Url(value, bytes) !== null, {
    message: `expected ${bytes} bytes of base64url`,
  });

/** `POST /api/gateway/pairing-code/pake/start` 的请求体（§73.1）。 */
export const pairingPakeStartSchema = z
  .object({ sid: b64(PAIRING_PAKE_SID_BYTES), share: b64(ELEMENT_BYTES) })
  .strict();

export type PairingPakeStart = z.infer<typeof pairingPakeStartSchema>;

/** 它的回答：每一枚活着的配对码一个候选。 */
export const pairingPakeOffersSchema = z.object({
  session: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  offers: z
    .array(z.object({ share: b64(ELEMENT_BYTES), confirm: b64(TAG_BYTES) }))
    .max(PAIRING_PAKE_MAX_OFFERS),
});

export type PairingPakeOffers = z.infer<typeof pairingPakeOffersSchema>;

/** `POST /api/gateway/pairing-code/pake/finish` 的请求体（§73.2）。 */
export const pairingPakeFinishSchema = z
  .object({
    session: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    index: z
      .number()
      .int()
      .min(0)
      .max(PAIRING_PAKE_MAX_OFFERS - 1),
    confirm: b64(TAG_BYTES),
  })
  .strict();

export type PairingPakeFinish = z.infer<typeof pairingPakeFinishSchema>;

/** 它的回答与 §17.3 / §24 的配对载荷同形。 */
export const pairingPakePayloadSchema = gatewayPairingPayloadSchema;
