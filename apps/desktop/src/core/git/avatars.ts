import { OUTBOUND } from "../net/outbound";
import { settingsDomain } from "../settings";

/**
 * 提交作者的 GitHub 头像（#927）。
 *
 * 页面从 GitHub 的 noreply 邮箱（`<id>+<login>@users.noreply.github.com`）里认出
 * 账号 id，交给这里取图；答 data URL，页面直接放进 `<img>`。这样：
 *
 * - **页面不直连图片主机**：桌面、网页、经中继的手机走的都是同一条 RPC，CSP 的
 *   `img-src` 不用为一个外部域放开；
 * - **能关**：`git.avatars` 关掉之后这里一个请求都不发（出站登记见
 *   `net/outbound.ts` 的 `githubAvatars`）；
 * - **不反复问**：结果按 id 缓存一天，失败也缓存半小时；同时在飞的同一个 id 共用
 *   一次请求。
 *
 * 不用 Gravatar：那要把邮箱的哈希交给第三方，而这里只用到邮箱里本来就公开的
 * GitHub 账号 id。
 */

const HIT_TTL = 24 * 60 * 60 * 1000;
const MISS_TTL = 30 * 60 * 1000;
const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 5_000;
const SIZE = 64;
const MAX_ENTRIES = 2_000;

interface Entry {
  readonly dataUrl: string | null;
  readonly expires: number;
}

const cache = new Map<number, Entry>();
const inflight = new Map<number, Promise<string | null>>();

export interface AvatarDeps {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  /** 缺省读设置 `git.avatars`。 */
  readonly enabled?: () => boolean;
}

function avatarsEnabled(): boolean {
  return settingsDomain()?.settings.get("git.avatars") !== false;
}

async function fetchOne(
  id: number,
  fetcher: typeof globalThis.fetch,
): Promise<string | null> {
  try {
    const response = await fetcher(
      `${OUTBOUND.githubAvatars.url}${id}?s=${SIZE}&v=4`,
      { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" },
    );
    if (!response.ok) return null;
    const type = (response.headers.get("content-type") ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase();
    // 只收位图：SVG 能带脚本，data URL 也不例外。
    if (!/^image\/(png|jpeg|gif|webp)$/.test(type)) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_BYTES) return null;
    return `data:${type};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

export async function avatars(
  ids: readonly number[],
  deps: AvatarDeps = {},
): Promise<{ avatars: { id: number; dataUrl: string | null }[] }> {
  const unique = [...new Set(ids)].filter(
    (id) => Number.isSafeInteger(id) && id > 0,
  );
  const enabled = (deps.enabled ?? avatarsEnabled)();
  if (!enabled) {
    return { avatars: unique.map((id) => ({ id, dataUrl: null })) };
  }
  const now = deps.now ?? Date.now;
  const fetcher = deps.fetch ?? ((...args) => globalThis.fetch(...args));
  const answers = await Promise.all(
    unique.map(async (id) => {
      const hit = cache.get(id);
      if (hit && hit.expires > now()) return { id, dataUrl: hit.dataUrl };
      let pending = inflight.get(id);
      if (!pending) {
        pending = fetchOne(id, fetcher).finally(() => inflight.delete(id));
        inflight.set(id, pending);
      }
      const dataUrl = await pending;
      if (cache.size >= MAX_ENTRIES) cache.clear();
      cache.set(id, {
        dataUrl,
        expires: now() + (dataUrl ? HIT_TTL : MISS_TTL),
      });
      return { id, dataUrl };
    }),
  );
  return { avatars: answers };
}

/** 测试用：清掉缓存，让每条用例从空开始。 */
export function resetAvatarCache(): void {
  cache.clear();
  inflight.clear();
}
