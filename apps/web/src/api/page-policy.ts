/**
 * 服务器壳页面的 CSP 跟着源表走（契约 §88.1）：Gateway 发页面时按源表追加连接来源，
 * 而 CSP 只在页面载入时生效。页面启动时记下载入时那份 `connect-src`；源表变了再问一次
 * 页面入口，多出了来源就要重载才放行——与桌面壳 `sources.changed()` 答 `reload` 同一个
 * 意思（`shell-core/remote-trust.ts` 的 `addsOrigins`）。
 */

type Fetch = typeof fetch;

async function connectSources(
  fetcher: Fetch,
): Promise<ReadonlySet<string> | null> {
  try {
    const response = await fetcher("/", {
      method: "HEAD",
      cache: "no-store",
      credentials: "same-origin",
    });
    const policy = response.headers.get("content-security-policy") ?? "";
    const directive = policy
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("connect-src "));
    return directive === undefined
      ? null
      : new Set(directive.split(/\s+/).slice(1));
  } catch {
    return null;
  }
}

let loaded: Promise<ReadonlySet<string> | null> | null = null;

/** 页面启动时记下载入时的 `connect-src`（只记一次）。 */
export function rememberPagePolicy(
  fetcher: Fetch = (input, init) => globalThis.fetch(input, init),
): void {
  loaded ??= connectSources(fetcher);
}

/** 源表变了之后：页面入口的 `connect-src` 比载入时多了来源，就答 `true`（要重载）。 */
export async function pagePolicyGrew(
  fetcher: Fetch = (input, init) => globalThis.fetch(input, init),
): Promise<boolean> {
  const before = await (loaded ?? Promise.resolve(null));
  if (before === null) return false;
  const now = await connectSources(fetcher);
  return now !== null && [...now].some((token) => !before.has(token));
}

/** 测试用：忘掉记下的那份。 */
export function resetPagePolicy(): void {
  loaded = null;
}
