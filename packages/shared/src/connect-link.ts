import { issuerOrigin } from "./join-link.js";

/**
 * 「连接手机」的二维码（契约 §99）：一张码装下直连与中转两条路。
 *
 * 二维码文本是网页链接 `<网页来源>/#c=2&s=<源>&e=<截止>&o=<来源…>&t=<票>&f=<锚>&k=<身份公钥>
 * &p=<秘密>&i=<签发方…>`：载荷在片段里，片段不上请求行，所以不进任何访问日志，也不进
 * `Referer`。手机相机扫到它会打开网页，App 内的扫码器直接解析同一串。`c` 是载荷版本
 * （固定 `2`），其余键直写，不再套 base64(JSON)。
 *
 *   - 直连半 `o/t/f` 同进同出：Gateway 的 `host:port`（逗号分隔，最多 3 个）、一次性配对票、
 *     信任锚 SHA-256（base64url，43 字符）。
 *   - 中转半 `k/p/i` 同进同出：身份公钥（base64url，32 字节）、一次性配对秘密（16 字节）、
 *     签发方来源（逐个百分号编码，逗号分隔，最多 2 个）。
 *   - 至少要有一半。缺键、多出不认识的键、重复的键、长度不对，一律拒绝。
 */

export const CONNECT_VERSION = 2;
/** 手机时钟与 core 的允许误差；最终以 core 的判定为准。 */
export const CONNECT_CLOCK_SKEW_MS = 60_000;
export const CONNECT_MAX_ORIGINS = 3;
export const CONNECT_MAX_ISSUERS = 2;

export interface ConnectDirect {
  /** `https://host:port`，与 Gateway 的 `origins` 同序，已去掉回环。 */
  readonly origins: readonly string[];
  readonly ticket: string;
  /** 信任锚 DER 的 SHA-256，小写十六进制（64 位）。 */
  readonly fingerprint: string;
}

export interface ConnectRelay {
  /** 身份公钥，base64url（32 字节）。 */
  readonly identityPub: string;
  /** 一次性配对秘密，base64url（16 字节）。 */
  readonly secret: string;
  readonly issuers: readonly string[];
}

export interface ConnectPayload {
  /** core 的 `hostId`（32 位十六进制）。 */
  readonly sourceId: string;
  readonly expiresAtMs: number;
  readonly direct: ConnectDirect | null;
  readonly relay: ConnectRelay | null;
}

const SOURCE = /^[0-9a-f]{32}$/;
const TICKET = /^[A-Za-z0-9._~-]{16,128}$/;
const ANCHOR = /^[A-Za-z0-9_-]{43}$/;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const SECRET = /^[A-Za-z0-9_-]{22}$/;
const HEX_FINGERPRINT = /^[0-9a-f]{64}$/;
const HOST_PORT =
  /^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?):(\d{1,5})$/;
const KEYS = new Set(["c", "s", "e", "o", "t", "f", "k", "p", "i"]);

function hexToBase64url(hex: string): string {
  let binary = "";
  for (let index = 0; index < hex.length; index += 2) {
    binary += String.fromCharCode(
      Number.parseInt(hex.slice(index, index + 2), 16),
    );
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlToHex(text: string): string {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=");
  let hex = "";
  for (let index = 0; index < binary.length; index += 1) {
    hex += binary.charCodeAt(index).toString(16).padStart(2, "0");
  }
  return hex;
}

/** `https://192.168.1.20:8443` → `192.168.1.20:8443`；默认端口也写出来。 */
function hostPort(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:") return null;
    const text = `${url.hostname}:${url.port === "" ? "443" : url.port}`;
    return HOST_PORT.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** 载荷 → 片段（不含 `#`）。载荷不合规矩时抛 `RangeError`：那是调用方的 bug。 */
export function encodeConnectFragment(payload: ConnectPayload): string {
  if (!SOURCE.test(payload.sourceId)) throw new RangeError("sourceId");
  if (!Number.isSafeInteger(payload.expiresAtMs) || payload.expiresAtMs <= 0) {
    throw new RangeError("expiresAtMs");
  }
  const parts = [
    `c=${CONNECT_VERSION}`,
    `s=${payload.sourceId}`,
    `e=${payload.expiresAtMs}`,
  ];
  const { direct, relay } = payload;
  if (direct === null && relay === null) throw new RangeError("no half");
  if (direct !== null) {
    const origins = direct.origins.map(hostPort);
    if (
      origins.length === 0 ||
      origins.length > CONNECT_MAX_ORIGINS ||
      origins.includes(null)
    ) {
      throw new RangeError("origins");
    }
    if (!TICKET.test(direct.ticket)) throw new RangeError("ticket");
    if (!HEX_FINGERPRINT.test(direct.fingerprint)) {
      throw new RangeError("fingerprint");
    }
    parts.push(
      `o=${origins.join(",")}`,
      `t=${direct.ticket}`,
      `f=${hexToBase64url(direct.fingerprint)}`,
    );
  }
  if (relay !== null) {
    if (!PUBLIC_KEY.test(relay.identityPub))
      throw new RangeError("identityPub");
    if (!SECRET.test(relay.secret)) throw new RangeError("secret");
    const issuers = relay.issuers.map(issuerOrigin);
    if (
      issuers.length === 0 ||
      issuers.length > CONNECT_MAX_ISSUERS ||
      issuers.includes(null)
    ) {
      throw new RangeError("issuers");
    }
    parts.push(
      `k=${relay.identityPub}`,
      `p=${relay.secret}`,
      `i=${issuers.map((one) => encodeURIComponent(one as string)).join(",")}`,
    );
  }
  return parts.join("&");
}

/** 二维码文本：`<网页来源>/#c=…`。 */
export function connectUrl(webOrigin: string, payload: ConnectPayload): string {
  const origin = new URL(webOrigin).origin;
  return `${origin}/#${encodeConnectFragment(payload)}`;
}

export type ConnectRejection = "older" | "newer" | "expired" | "invalid";

export type ConnectParse =
  | {
      readonly ok: true;
      readonly payload: ConnectPayload;
      /** 二维码指向的网页来源（浏览器扫码时就是页面所在的来源）。 */
      readonly webOrigin: string;
    }
  | { readonly ok: false; readonly reason: ConnectRejection };

const fail = (reason: ConnectRejection): ConnectParse => ({
  ok: false,
  reason,
});

/**
 * 扫到的文本 → 载荷。`now` 给了就核截止时刻（允许 {@link CONNECT_CLOCK_SKEW_MS} 的
 * 误差）。旧版二维码（`armadra://pair?`、`armadra://pair-e2e?`、`c` 小于 2）答
 * `older`，`c` 大于 2 答 `newer`；认不出的答 `invalid`。
 */
export function parseConnect(text: string, now?: number): ConnectParse {
  const trimmed = text.trim();
  if (/^armadra:\/\/pair(?:-e2e)?(?:[?/]|$)/i.test(trimmed))
    return fail("older");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return fail("invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return fail("invalid");
  if (!url.hash.startsWith("#c=")) return fail("invalid");
  if (url.pathname !== "/" && url.pathname !== "") return fail("invalid");
  const values = new Map<string, string>();
  for (const pair of url.hash.slice(1).split("&")) {
    const cut = pair.indexOf("=");
    if (cut <= 0) return fail("invalid");
    const key = pair.slice(0, cut);
    if (!KEYS.has(key) || values.has(key)) return fail("invalid");
    values.set(key, pair.slice(cut + 1));
  }
  const version = values.get("c") ?? "";
  if (!/^\d{1,3}$/.test(version)) return fail("invalid");
  const number = Number(version);
  if (number < CONNECT_VERSION) return fail("older");
  if (number > CONNECT_VERSION) return fail("newer");
  const sourceId = values.get("s") ?? "";
  const expires = values.get("e") ?? "";
  if (!SOURCE.test(sourceId) || !/^\d{1,15}$/.test(expires))
    return fail("invalid");
  const expiresAtMs = Number(expires);
  if (expiresAtMs <= 0) return fail("invalid");

  const directKeys = ["o", "t", "f"].filter((key) => values.has(key)).length;
  const relayKeys = ["k", "p", "i"].filter((key) => values.has(key)).length;
  if (
    (directKeys !== 0 && directKeys !== 3) ||
    (relayKeys !== 0 && relayKeys !== 3)
  ) {
    return fail("invalid");
  }
  if (directKeys === 0 && relayKeys === 0) return fail("invalid");

  let direct: ConnectDirect | null = null;
  if (directKeys === 3) {
    const hosts = (values.get("o") ?? "").split(",");
    if (hosts.length > CONNECT_MAX_ORIGINS) return fail("invalid");
    const origins: string[] = [];
    for (const host of hosts) {
      const match = HOST_PORT.exec(host);
      if (match === null || Number(match[1]) < 1 || Number(match[1]) > 65535) {
        return fail("invalid");
      }
      origins.push(`https://${host}`);
    }
    const ticket = values.get("t") ?? "";
    const anchor = values.get("f") ?? "";
    if (!TICKET.test(ticket) || !ANCHOR.test(anchor)) return fail("invalid");
    let fingerprint: string;
    try {
      fingerprint = base64urlToHex(anchor);
    } catch {
      return fail("invalid");
    }
    if (!HEX_FINGERPRINT.test(fingerprint)) return fail("invalid");
    direct = { origins, ticket, fingerprint };
  }

  let relay: ConnectRelay | null = null;
  if (relayKeys === 3) {
    const identityPub = values.get("k") ?? "";
    const secret = values.get("p") ?? "";
    if (!PUBLIC_KEY.test(identityPub) || !SECRET.test(secret))
      return fail("invalid");
    const raw = (values.get("i") ?? "").split(",");
    if (raw.length > CONNECT_MAX_ISSUERS) return fail("invalid");
    const issuers: string[] = [];
    for (const item of raw) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(item);
      } catch {
        return fail("invalid");
      }
      const origin = issuerOrigin(decoded);
      if (origin === null || origin !== decoded) return fail("invalid");
      issuers.push(origin);
    }
    relay = { identityPub, secret, issuers };
  }

  if (now !== undefined && expiresAtMs + CONNECT_CLOCK_SKEW_MS <= now) {
    return fail("expired");
  }
  return {
    ok: true,
    payload: { sourceId, expiresAtMs, direct, relay },
    webOrigin: url.origin,
  };
}
