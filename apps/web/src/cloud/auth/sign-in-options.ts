import { usePlatformInfo } from "../api/queries";

export const OAUTH_PROVIDERS = ["github", "google"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export const isOAuthProvider = (value: string): value is OAuthProvider =>
  (OAUTH_PROVIDERS as readonly string[]).includes(value);

export interface SignInOptions {
  /** 能力位还没取回来。 */
  readonly loading: boolean;
  /** 口令登录、口令注册与找回口令（`auth.password`）。 */
  readonly password: boolean;
  /** 账号页的「更改口令」（`auth.password-change`）。 */
  readonly passwordChange: boolean;
  /** 开放的第三方登录（`auth.oauth.<提供方>`），顺序固定。 */
  readonly providers: readonly OAuthProvider[];
}

/**
 * 登录方式（`platform.info.capabilities`）。取不到平台信息时按旧服务端处理：只有口令，
 * 没有第三方登录，免得网络抖动把登录页锁死。
 */
export function useSignInOptions(): SignInOptions {
  const info = usePlatformInfo();
  if (info.isPending)
    return {
      loading: true,
      password: false,
      passwordChange: false,
      providers: [],
    };
  if (info.data === undefined)
    return {
      loading: false,
      password: true,
      passwordChange: true,
      providers: [],
    };
  const caps = new Set(info.data.capabilities);
  return {
    loading: false,
    password: caps.has("auth.password"),
    passwordChange: caps.has("auth.password-change"),
    providers: OAUTH_PROVIDERS.filter((provider) =>
      caps.has(`auth.oauth.${provider}`),
    ),
  };
}
