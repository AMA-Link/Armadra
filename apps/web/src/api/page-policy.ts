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

/** 违规触发的重载记在本标签页：这段时间里不再因违规重载，不会循环。 */
export const VIOLATION_RELOAD_KEY = "armadra.csp.violationReloadAt";
export const VIOLATION_RELOAD_GAP_MS = 5 * 60_000;

function hostOf(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

export interface ViolationWatchOptions {
  /** 源表里页面会去连的来源（签发方、中继、直连）。 */
  readonly knownOrigins: () => Iterable<string>;
  readonly reload?: () => void;
  /** 重载帮不上（新的授权里也没有被拦的主机）时怎么提示；缺省只记一行控制台警告。 */
  readonly notify?: (blockedHost: string) => void;
  /** 问页面入口的 CSP（测试注入）。 */
  readonly fetch?: Fetch;
  readonly storage?: Pick<Storage, "getItem" | "setItem"> | null;
  readonly now?: () => number;
  readonly target?: Pick<
    EventTarget,
    "addEventListener" | "removeEventListener"
  >;
}

/**
 * 服务器壳页面载入时可能按匿名拿到 CSP（从跨站链接进来、访问 Cookie 带不上），直连源
 * 就被拦（契约 §88.1）。`connect-src` 拦的是源表里的来源时：先 `HEAD /` 看新发的那份
 * 授权里**确实有**被拦的主机，才整页重载一次（同站重载会带上会话 Cookie，换回 owner 那份
 * CSP）；没有就只提示——重载也拿不到，只会白刷一次。记号写在 `sessionStorage`，同一标签页
 * {@link VIOLATION_RELOAD_GAP_MS} 内只重载一次；`sessionStorage` 不可用时记不住，干脆不重载，
 * 免得循环。答拆除函数。
 */
export function watchPolicyViolations(
  options: ViolationWatchOptions,
): () => void {
  const target = options.target ?? globalThis.document;
  if (target === undefined) return () => undefined;
  const storage =
    options.storage === undefined
      ? (() => {
          try {
            return globalThis.sessionStorage ?? null;
          } catch {
            return null;
          }
        })()
      : options.storage;
  const now = options.now ?? Date.now;
  const reload = options.reload ?? (() => globalThis.location?.reload());
  const notify =
    options.notify ??
    ((host: string) =>
      console.warn(
        `Armadra: connection to ${host} is blocked by the page policy`,
      ));
  const fetcher: Fetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  let done = false;
  const decide = async (blocked: string) => {
    const granted = await connectSources(fetcher);
    const covers =
      granted !== null &&
      [...granted].some((token) => hostOf(token) === blocked);
    if (!covers) {
      notify(blocked);
      return;
    }
    try {
      storage!.setItem(VIOLATION_RELOAD_KEY, String(now()));
    } catch {
      // 记不下就不重载：下一页仍被拦时没有记号挡着，会一直刷。
      notify(blocked);
      return;
    }
    reload();
  };
  const listener = (event: Event) => {
    const violation = event as SecurityPolicyViolationEvent;
    if (done || !violation.effectiveDirective?.startsWith("connect-src"))
      return;
    const blocked = hostOf(violation.blockedURI ?? "");
    if (blocked === "") return;
    const known = [...options.knownOrigins()].map(hostOf);
    if (!known.includes(blocked)) return;
    done = true;
    if (storage === null) {
      notify(blocked);
      return;
    }
    let last: number;
    try {
      last = Number(storage.getItem(VIOLATION_RELOAD_KEY) ?? "0");
    } catch {
      notify(blocked);
      return;
    }
    if (Number.isFinite(last) && now() - last < VIOLATION_RELOAD_GAP_MS) return;
    void decide(blocked);
  };
  target.addEventListener("securitypolicyviolation", listener);
  return () => target.removeEventListener("securitypolicyviolation", listener);
}
