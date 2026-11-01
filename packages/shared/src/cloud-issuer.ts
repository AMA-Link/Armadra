/**
 * Armadra 云（SaaS）的默认地址。客户端（手机、桌面、服务器壳的 `cloud login`）只支持
 * 直接登录这一个云，界面上不再让人输入地址；个人中转（用户自建）仍然要填地址。
 */
export const ARMADRA_CLOUD_ISSUER = "https://app.armadra.com";

/** 覆盖地址的环境变量：桌面 core / 服务器壳读进程环境，网页与手机读构建时的 `VITE_` 同名变量。 */
export const ARMADRA_CLOUD_ISSUER_ENV = "ARMADRA_CLOUD_ISSUER";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * 开发与测试用的覆盖值是否可用：必须是只有来源的 https 地址（回环另收 http），不带账号口令、
 * 路径、查询与片段。可用时返回规范化的来源，否则 `null`。
 */
export function cloudIssuerOverride(
  value: string | undefined | null,
): string | null {
  const text = (value ?? "").trim();
  if (text === "") return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const secure =
    url.protocol === "https:" ||
    (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  if (
    !secure ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  )
    return null;
  return url.origin;
}

/** 实际使用的 Armadra 云地址：覆盖值可用就用它，否则（含不合规）用 {@link ARMADRA_CLOUD_ISSUER}。 */
export function resolveCloudIssuer(
  override?: string | undefined | null,
): string {
  return cloudIssuerOverride(override) ?? ARMADRA_CLOUD_ISSUER;
}
