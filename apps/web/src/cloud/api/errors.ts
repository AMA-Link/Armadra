import { t as translate } from "@/app/preferences-store";
import { localizedFailure } from "../../api/request";

/**
 * 控制台里所有失败的统一形状：协议的线上错误 `{ code, message, requestId?, details? }`
 * 加 HTTP 状态。真实客户端与 mock 抛同一个类，页面只认它（云端控制台 §6.3）。
 * `message` 是后端的原话，**不展示**：文案一律按 `code` 取（{@link cloudMessage}）。
 */
export class CloudConsoleError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string = code,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "CloudConsoleError";
  }
}

/** 会话没了：清缓存、回登录，不出错误文案。 */
const SESSION_CODES: ReadonlySet<string> = new Set([
  "unauthenticated",
  "session_expired",
  "session_revoked",
]);

export function isSessionError(error: unknown): boolean {
  return error instanceof CloudConsoleError && SESSION_CODES.has(error.code);
}

/** 文案里写「联系支持」的码：旁边给「联系支持」按钮（§1.3）。 */
export function needsSupport(code: string): boolean {
  return code === "account_disabled" || code === "team_suspended";
}

/**
 * 控制台自己的码 → 文案键（§6.4）。先查这张表，再退回 `api/request.ts` 的
 * `MESSAGE_BY_CODE`（`credentials_invalid`、`forbidden`、`link_*`、`password_*`…）。
 */
export const CLOUD_MESSAGE_BY_CODE: Readonly<Record<string, string>> = {
  account_locked: "cloud.auth.locked",
  account_disabled: "error.accountDisabled",
  email_taken: "error.emailTaken",
  email_unverified: "error.emailUnverified",
  mfa_invalid: "error.mfaInvalid",
  mfa_expired: "error.mfaExpired",
  device_code_expired: "error.deviceCodeExpired",
  device_code_denied: "error.deviceCodeDenied",
  email_token_invalid: "error.emailTokenInvalid",
  email_token_expired: "error.emailTokenExpired",
  team_slug_taken: "error.teamSlugTaken",
  team_role_insufficient: "error.teamRoleInsufficient",
  team_last_owner: "error.teamLastOwner",
  team_owner_required: "error.teamOwnerRequired",
  team_suspended: "error.teamSuspended",
  team_deleted: "error.teamDeleted",
  invitation_expired: "error.invitationExpired",
  invitation_email_mismatch: "error.invitationEmailMismatch",
  invitation_revoked: "error.invitationRevoked",
  member_exists: "error.memberExists",
  host_registration_disabled: "error.hostRegistrationDisabled",
  guests_disabled: "error.guestsDisabled",
  plan_feature_unavailable: "error.planFeatureUnavailable",
  transfer_pending: "error.transferPending",
  transfer_expired: "error.transferExpired",
  device_untrusted: "cloud.trust.useTrusted",
  link_frozen: "error.linkFrozen",
  team_policy_denied: "error.teamPolicyDenied",
  registrations_paused: "cloud.auth.registrationsClosed",
  operator_mfa_required: "error.operatorMfaRequired",
};

/** 会话码与「改成别的交互」的码：没有错误文案。 */
const NO_COPY: ReadonlySet<string> = new Set([
  ...SESSION_CODES,
  "anonymous_links_disabled",
]);

const QUOTAS: ReadonlySet<string> = new Set([
  "hosts",
  "members",
  "guests",
  "concurrent",
  "traffic",
  "teams",
]);

function detail(details: unknown, key: string): unknown {
  return typeof details === "object" && details !== null
    ? (details as Record<string, unknown>)[key]
    : undefined;
}

/**
 * 错误码 → 界面上那句话。`null` = 这个码不出文案（会话失效回登录、匿名链接改成
 * 「登录后加入」）。认不出的码是 `error.internal`；后端的 `message` 从不展示。
 */
export function cloudMessage(
  code: string,
  details?: unknown,
  t: typeof translate = translate,
): string | null {
  if (NO_COPY.has(code)) return null;
  if (code === "limit_reached") {
    const quota = detail(details, "quota");
    return typeof quota === "string" && QUOTAS.has(quota)
      ? t(`cloud.billing.limit.${quota}`)
      : t("error.limitReached");
  }
  if (code === "account_locked") {
    const wait = detail(details, "retryAfterMs");
    return typeof wait === "number" && wait > 0
      ? t("cloud.auth.locked", { minutes: Math.ceil(wait / 60_000) })
      : t("error.accountLocked");
  }
  if (code === "invitation_email_mismatch") {
    const email = detail(details, "email");
    return typeof email === "string"
      ? t("error.invitationEmailMismatch", { email })
      : t("error.invitationInvalid");
  }
  const key = CLOUD_MESSAGE_BY_CODE[code];
  if (key !== undefined) return t(key);
  return localizedFailure(code, t("error.internal"));
}

/** 这个失败的文案；没有文案的码给 `error.internal`（用在非会话场合的兜底）。 */
export function describeFailure(error: unknown): string {
  const failure = toCloudError(error);
  return (
    cloudMessage(failure.code, failure.details) ?? translate("error.internal")
  );
}

/** 线上错误体 `{ code, message, requestId?, details? }`。 */
function wireOf(value: unknown): {
  code: string;
  message?: string;
  details?: unknown;
  requestId?: string;
} | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  // 真实客户端把原始响应体放进 `data.body`，解码器命中时直接放在 `data`。
  const inner = record.body ?? record;
  if (typeof inner !== "object" || inner === null) return null;
  const wire = inner as Record<string, unknown>;
  return typeof wire.code === "string"
    ? {
        code: wire.code,
        ...(typeof wire.message === "string" ? { message: wire.message } : {}),
        ...(wire.details === undefined ? {} : { details: wire.details }),
        ...(typeof wire.requestId === "string"
          ? { requestId: wire.requestId }
          : {}),
      }
    : null;
}

/** 状态码兜底：线上没有认得的错误体时（网关页、空 body）。 */
function codeOfStatus(status: number): string {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 502 || status === 503 || status === 504) return "unavailable";
  return "internal";
}

/**
 * 任何抛出的东西 → {@link CloudConsoleError}。认得：自己的类；携带 `status` 与线上错误体的
 * 对象（`@orpc/client` 的错误，不在这里 import）；网络失败（`TypeError` / `AbortError`，
 * 状态 0，当作暂时不可用）。
 */
export function toCloudError(error: unknown): CloudConsoleError {
  if (error instanceof CloudConsoleError) return error;
  if (typeof error === "object" && error !== null) {
    const record = error as {
      status?: unknown;
      code?: unknown;
      message?: unknown;
      data?: unknown;
    };
    const status = typeof record.status === "number" ? record.status : 0;
    const wire = wireOf(record.data);
    if (wire !== null)
      return new CloudConsoleError(
        wire.code,
        status,
        wire.message,
        wire.details,
        wire.requestId,
      );
    if (status > 0)
      return new CloudConsoleError(
        codeOfStatus(status),
        status,
        typeof record.message === "string" ? record.message : undefined,
      );
  }
  const network =
    error instanceof TypeError ||
    (error instanceof Error && error.name === "AbortError");
  return new CloudConsoleError(
    network ? "unavailable" : "internal",
    0,
    error instanceof Error ? error.message : undefined,
  );
}

/** 值得自动重试：网络失败与 5xx；其余（4xx）重试也一样。 */
export function isTransient(error: unknown): boolean {
  const failure = toCloudError(error);
  return failure.status === 0 || failure.status >= 500;
}
