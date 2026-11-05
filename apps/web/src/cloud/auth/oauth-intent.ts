import { safeNext } from "./redirect";
import type { OAuthProvider } from "./sign-in-options";

/**
 * 第三方授权要整页跳走再跳回来；回跳页 `/login/oauth/:provider` 要知道这次是提权还是绑定
 * （登录没有意图：存下的 `next` 另走 `rememberOAuthNext`）。意图只决定调哪个 finish，
 * 目的以服务端 state 为准，对不上服务端答 401。
 */
export type OAuthIntent =
  | { readonly purpose: "reauth"; readonly provider: OAuthProvider }
  | { readonly purpose: "link"; readonly provider: OAuthProvider };

/** 提权成功后要接着做的事（跳转前存下，回来自动续）。 */
export type PendingAction =
  | { readonly kind: "emailChange"; readonly newEmail: string }
  | { readonly kind: "linkProvider"; readonly provider: OAuthProvider }
  | { readonly kind: "unlinkProvider"; readonly provider: OAuthProvider };

interface StoredIntent {
  readonly intent: OAuthIntent;
  /** 跳转时所在的页面，回跳处理完回到这里。 */
  readonly returnTo: string;
  readonly action: PendingAction | null;
  readonly atMs: number;
}

const INTENT_KEY = "armadra.cloud.oauthIntent";
const PENDING_KEY = "armadra.cloud.pendingAction";
/** 与服务端 state 的有效期一致：更久的意图不再认。 */
const INTENT_TTL_MS = 10 * 60_000;

const read = (key: string): unknown => {
  try {
    const raw = sessionStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
};

const write = (key: string, value: unknown | null) => {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 存储不可用（隐私模式）：回跳后走缺省行为。
  }
};

/** 跳出去之前存意图；`action` 是提权后要接着做的事。 */
export function rememberOAuthIntent(
  intent: OAuthIntent,
  returnTo: string,
  action: PendingAction | null = null,
  now: number = Date.now(),
): void {
  const stored: StoredIntent = { intent, returnTo, action, atMs: now };
  write(INTENT_KEY, stored);
}

/** 回跳页取意图；没有、过期或损坏是 `null`（按登录处理）。`returnTo` 再过一遍 {@link safeNext}。 */
export function recalledOAuthIntent(now: number = Date.now()): {
  intent: OAuthIntent;
  returnTo: string;
  action: PendingAction | null;
} | null {
  const value = read(INTENT_KEY) as Partial<StoredIntent> | null;
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.atMs !== "number" ||
    now - value.atMs > INTENT_TTL_MS
  )
    return null;
  const { intent } = value;
  if (
    intent === undefined ||
    (intent.purpose !== "reauth" && intent.purpose !== "link") ||
    typeof intent.provider !== "string"
  )
    return null;
  return {
    intent,
    returnTo: safeNext(value.returnTo) ?? "/me/account",
    action: value.action ?? null,
  };
}

export const forgetOAuthIntent = () => write(INTENT_KEY, null);

/** 提权完成：把要接着做的事留给回到的页面取用。 */
export const leavePendingAction = (action: PendingAction | null) =>
  write(PENDING_KEY, action);

/** 页面挂载时取走属于自己的待续操作（一次性）；不是这些种类的留着。 */
export function takePendingAction<K extends PendingAction["kind"]>(
  kinds: readonly K[],
): Extract<PendingAction, { kind: K }> | null {
  const value = read(PENDING_KEY) as PendingAction | null;
  if (value === null || !(kinds as readonly string[]).includes(value.kind))
    return null;
  write(PENDING_KEY, null);
  return value as Extract<PendingAction, { kind: K }>;
}
