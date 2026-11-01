/**
 * 会话起不来时页面说什么（契约 §14.1 的起会话错误码）。
 *
 * 码来自 core 的 `RuntimeRequestError.code`；每个码一句话，认不出的码一律落到
 * 通用的「会话没有启动」。映射只写在这一个函数里，页面与测试都问它。
 */

import {
  acpAuthRequiredDetailsSchema,
  type AcpAuthMethodInfo,
} from "@armadra/shared";

import { RuntimeRequestError } from "@/api/request";

const START_FAILURE_KEYS: Readonly<Record<string, string>> = {
  acp_auth_required: "acp.error.authRequired",
  acp_not_installed: "acp.error.notInstalled",
  acp_mode_unavailable: "acp.error.modeUnavailable",
  acp_mode_unsupported: "acp.error.modeUnavailable",
  acp_protocol_version: "acp.error.protocolVersion",
  acp_session_timeout: "acp.error.timeout",
};

/** 起会话失败的码 → 界面文案的键；`null`/未知码 = 通用文案。 */
export function startFailureKey(code: string | null | undefined): string {
  if (code === null || code === undefined) return "acp.error.start";
  return START_FAILURE_KEYS[code] ?? "acp.error.start";
}

/**
 * `acp_auth_required` 带出的登录方式（错误体的 `details.authMethods`）。只留 core
 * 跑得了的（`supported` 为真）：旧 core 或旧客户端不给 `supported`，此时没有
 * 可点的方法，页面只说「请先在终端里用该 CLI 登录」。
 */
export function authMethodsOf(error: unknown): AcpAuthMethodInfo[] {
  if (
    !(error instanceof RuntimeRequestError) ||
    error.code !== "acp_auth_required"
  ) {
    return [];
  }
  const details = (error.body as { details?: unknown } | null | undefined)
    ?.details;
  const parsed = acpAuthRequiredDetailsSchema.safeParse(details);
  return parsed.success
    ? parsed.data.authMethods.filter((method) => method.supported === true)
    : [];
}
