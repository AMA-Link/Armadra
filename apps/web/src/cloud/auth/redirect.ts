/**
 * 登录后回哪里（`/login?next=`）：只认站内绝对路径。`//host`、`/\host`、带协议的一律丢弃，
 * 免得登录页被拿去做开放重定向。
 */
export function safeNext(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (value.includes("\\") || [...value].some((c) => c.charCodeAt(0) < 32))
    return null;
  // 登录页自己与公开页不当落点，免得原地打转。
  if (/^\/(login|register|verify|reset)(\/|\?|$)/.test(value)) return null;
  return value;
}

/** `#` 片段里的一次性令牌（邮件链接 `<APP_ORIGIN>/verify#<令牌>`，§4.3）；没有是 `""`。 */
export function fragmentToken(hash: string = window.location.hash): string {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** 令牌读出来就从地址栏拿掉，不留在历史与分享里（邀请页要带着去登录，不拿）。 */
export function stripFragment(): void {
  if (window.location.hash === "") return;
  window.history.replaceState(
    null,
    "",
    window.location.pathname + window.location.search,
  );
}

const OAUTH_NEXT_KEY = "armadra.cloud.oauthNext";

/**
 * 第三方登录要整页跳走再跳回来：登录前的落点（`next`，含 `/device?code=…`）先存 `sessionStorage`，
 * 回跳页取用。没有落点就清掉上一次留下的，免得串到别的登录里。
 */
export function rememberOAuthNext(next: string | null): void {
  try {
    if (next === null) sessionStorage.removeItem(OAUTH_NEXT_KEY);
    else sessionStorage.setItem(OAUTH_NEXT_KEY, next);
  } catch {
    // 存储不可用（隐私模式）：回跳后走缺省落点。
  }
}

/** 存着的落点（再过一遍 {@link safeNext}）；没有是 `null`。 */
export function recalledOAuthNext(): string | null {
  try {
    return safeNext(sessionStorage.getItem(OAUTH_NEXT_KEY));
  } catch {
    return null;
  }
}

export const forgetOAuthNext = () => rememberOAuthNext(null);

/** 整页跳到站外（提供方的授权页）；单独成对象，测试里可以替换。 */
export const external = {
  go(url: string): void {
    window.location.assign(url);
  },
};
