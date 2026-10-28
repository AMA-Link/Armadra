import {
  CloudTransportError,
  cloudPlatformInfo,
  type CloudPlatformInfo,
} from "../sources/cloud-client";
import { underRelayAppPath } from "../sources/hosted";

/** 主机画布（`/h/<hostId>`）与分享落地页（`/j/<linkId>`）不是控制台，沿用现有入口。 */
const NOT_CONSOLE = /^\/(h|j)(\/|$)/;

/** 平台信息一次的等待上限：入口在挂载之前等它。 */
export const PLATFORM_INFO_TIMEOUT_MS = 2_500;

function timedOut(error: unknown): boolean {
  if (!(error instanceof CloudTransportError)) return false;
  const cause = error.cause as { name?: unknown } | undefined;
  return cause?.name === "AbortError" || cause?.name === "TimeoutError";
}

/**
 * 问一次同源的平台信息。超时（对端慢、控制面刚起）再问一次：落错了就是把控制台
 * 当成服务器壳。答了 404、一页 HTML 是明确的「不是」，连不上也按「不是」，都不再问。
 */
async function platformInfoOnce(
  origin: string,
): Promise<CloudPlatformInfo | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await cloudPlatformInfo(origin, {
        timeoutMs: PLATFORM_INFO_TIMEOUT_MS,
      });
    } catch (error) {
      if (!timedOut(error)) return null;
    }
  }
  return null;
}

/**
 * 这个来源是不是 SaaS 控制台所在（云端控制台 §1.2）：同源的 `/.well-known/armadra-platform`
 * 答 `mode = saas` 且 `webApp` 就是页面来源。问不到当作不是。
 */
export async function isSaasOrigin(
  location: Pick<Location, "origin"> | undefined = globalThis.location,
): Promise<boolean> {
  if (location === undefined) return false;
  const info = await platformInfoOnce(location.origin);
  if (info === null || info.mode !== "saas") return false;
  try {
    return new URL(info.webApp ?? "").origin === location.origin;
  } catch {
    return false;
  }
}

/**
 * 这一页是不是 SaaS 控制台：来源是控制台（{@link isSaasOrigin}），路径不是画布与落地页。
 * 答控制台路径或 `null`。个人中转的 `/app/` 下不问（那里是中继托管页）。
 */
export async function detectConsole(
  location:
    | Pick<Location, "origin" | "pathname">
    | undefined = globalThis.location,
): Promise<string | null> {
  if (
    location === undefined ||
    underRelayAppPath(location.pathname) ||
    NOT_CONSOLE.test(location.pathname)
  )
    return null;
  return (await isSaasOrigin(location)) ? location.pathname : null;
}
