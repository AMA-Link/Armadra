/**
 * 会话起不来时页面说什么（契约 §14.1 的起会话错误码）。
 *
 * 码来自 core 的 `RuntimeRequestError.code`；每个码一句话，认不出的码一律落到
 * 通用的「会话没有启动」。映射只写在这一个函数里，页面与测试都问它。
 */

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
