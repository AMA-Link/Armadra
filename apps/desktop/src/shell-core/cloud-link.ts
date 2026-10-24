/**
 * 壳收到的「回到 Armadra 云」深链（云端控制台 §3.5.1）：`armadra://cloud`，可带
 * `?issuer=<云端地址>`。
 *
 * 与分享深链（`join-link.ts`）同一个模式：壳只认形状、转交规范化之后的那一条；
 * `app:cloud-link` 只是「有一条」的提醒，页面经 `app:take-cloud-link` 取走（只取一次）。
 * 页面收到后只是把「添加 Armadra 云」对话框打开（地址预填），**不**自动取设备码、
 * 不登录——人点了「获取设备码」才开始。深链里没有任何秘密，也不接受别的参数。
 *
 * `issuer` 必须是干净的来源：`https://`，或回环地址上的 `http://`；带账号口令、
 * 路径、查询、片段，或别的参数、超长的，整条一律不认。
 */

/** 深链的最大长度。 */
export const CLOUD_LINK_MAX = 512;

const BASE = "armadra://cloud";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function cleanIssuer(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const secure = url.protocol === "https:";
  const loopback = url.protocol === "http:" && LOOPBACK.has(url.hostname);
  if (!secure && !loopback) return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  return url.origin;
}

/** 认得出就答规范化的那一条（`armadra://cloud` 或 `armadra://cloud?issuer=…`），否则 `null`。 */
export function deepCloudLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length > CLOUD_LINK_MAX || !value.startsWith(BASE)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "armadra:" || url.hostname !== "cloud") return null;
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    return null;
  }
  if (url.pathname !== "" && url.pathname !== "/") return null;
  const names = [...url.searchParams.keys()];
  if (names.length === 0) return BASE;
  if (names.length !== 1 || names[0] !== "issuer") return null;
  const issuer = cleanIssuer(url.searchParams.get("issuer") ?? "");
  return issuer === null
    ? null
    : `${BASE}?issuer=${encodeURIComponent(issuer)}`;
}

/** 启动参数里的深链（Windows 与 Linux）；有几条取最后一条。 */
export function cloudLinkFromArgv(argv: readonly string[]): string | null {
  let found: string | null = null;
  for (const arg of argv) {
    const link = deepCloudLink(arg);
    if (link !== null) found = link;
  }
  return found;
}

/** 待转交的那一条：同一时间只留最新的，页面取走即清。 */
export class PendingCloudLink {
  private value: string | null;

  constructor(initial: string | null = null) {
    this.value = initial;
  }

  offer(url: unknown): boolean {
    const link = deepCloudLink(url);
    if (link === null) return false;
    this.value = link;
    return true;
  }

  take(): string | null {
    const value = this.value;
    this.value = null;
    return value;
  }
}
