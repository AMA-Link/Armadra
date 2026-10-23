/**
 * 「回到 Armadra 云」深链（`armadra://cloud`，云端控制台 §3.5.1）在页面里的待办：
 * 桌面壳校验并转交之后，设置 → 远程访问打开「添加 Armadra 云」对话框，地址预填。
 * 只在内存里；人点了「获取设备码」才开始登录，这里不触发任何请求。
 *
 * 页面对壳转来的东西不盲信：这里再核一遍，只认 `armadra://cloud` 与干净的 `issuer`
 * 来源（`https://`，回环才允许 `http://`）。
 */

type Listener = () => void;
const listeners = new Set<Listener>();
let offered: { readonly issuer: string } | null = null;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** 深链里的 issuer；认不出整条链接是 `null`，没有 issuer 是空串。 */
export function parseCloudLink(link: string): { issuer: string } | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== "armadra:" || url.hostname !== "cloud") return null;
  if (url.hash !== "" || url.username !== "" || url.password !== "") {
    return null;
  }
  if (url.pathname !== "" && url.pathname !== "/") return null;
  const names = [...url.searchParams.keys()];
  if (names.length === 0) return { issuer: "" };
  if (names.length !== 1 || names[0] !== "issuer") return null;
  let issuer: URL;
  try {
    issuer = new URL(url.searchParams.get("issuer") ?? "");
  } catch {
    return null;
  }
  const ok =
    issuer.protocol === "https:" ||
    (issuer.protocol === "http:" && LOOPBACK.has(issuer.hostname));
  if (!ok || issuer.username !== "" || issuer.password !== "") return null;
  if (issuer.pathname !== "/" || issuer.search !== "" || issuer.hash !== "") {
    return null;
  }
  return { issuer: issuer.origin };
}

/** 订阅新来的待办；返回退订。 */
export function onCloudIntent(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 交来一条 `armadra://cloud` 深链；认不出的丢掉，答有没有收下。 */
export function offerCloudLink(link: string): boolean {
  const parsed = parseCloudLink(link);
  if (parsed === null) return false;
  offered = parsed;
  for (const listener of [...listeners]) listener();
  return true;
}

/** 取走待办（只取一次）：要预填的 issuer，没有是空串；没有待办是 `null`。 */
export function takeCloudIntent(): string | null {
  const value = offered;
  offered = null;
  return value === null ? null : value.issuer;
}
