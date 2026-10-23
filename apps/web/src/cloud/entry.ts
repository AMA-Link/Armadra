import { cloudPlatformInfo } from "../sources/cloud-client";
import { underRelayAppPath } from "../sources/hosted";

/** 主机画布（`/h/<hostId>`）与分享落地页（`/j/<linkId>`）不是控制台，沿用现有入口。 */
const NOT_CONSOLE = /^\/(h|j)(\/|$)/;

/**
 * 这个来源是不是 SaaS 控制台所在（云端控制台 §1.2）：同源的 `/.well-known/armadra-platform`
 * 答 `mode = saas` 且 `webApp` 就是页面来源。问不到当作不是。
 */
export async function isSaasOrigin(
  location: Pick<Location, "origin"> | undefined = globalThis.location,
): Promise<boolean> {
  if (location === undefined) return false;
  const info = await cloudPlatformInfo(location.origin, {
    timeoutMs: 2_500,
  }).catch(() => null);
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
