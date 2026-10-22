import { cloudPlatformInfo } from "../sources/cloud-client";
import { underRelayAppPath } from "../sources/hosted";

/** 主机画布（`/h/<hostId>`）与分享落地页（`/j/<linkId>`）不是控制台，沿用现有入口。 */
const NOT_CONSOLE = /^\/(h|j)(\/|$)/;

/**
 * 这一页是不是 SaaS 控制台（云端控制台 §1.2）：同源的 `/.well-known/armadra-platform`
 * 答 `mode = saas` 且 `webApp` 就是页面来源，路径不是画布与落地页。答控制台路径
 * 或 `null`；问不到当作不是。个人中转的 `/app/` 下不问（那里是中继托管页）。
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
  const info = await cloudPlatformInfo(location.origin, {
    timeoutMs: 2_500,
  }).catch(() => null);
  if (info === null || info.mode !== "saas") return null;
  try {
    return new URL(info.webApp ?? "").origin === location.origin
      ? location.pathname
      : null;
  } catch {
    return null;
  }
}
