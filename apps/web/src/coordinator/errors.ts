import type { Translate } from "@/app/preferences-store";

/**
 * 来源 / 候选页的失败文案：core 的 `message` 是中文，英文界面不能直出，所以按
 * `code` 取本地文案；认不出的码只显示码本身，没有码（断网）才用兜底句。
 */

const KNOWN_ERRORS = new Set([
  "bad_request",
  "forge_not_wired",
  "sources_full",
  "conflict",
  "source_not_found",
  "candidate_not_found",
  "forbidden",
]);

export function failureText(
  error: unknown,
  t: Translate,
  fallback: string,
  /** 这次保存的是 auto 来源：`bad_request` 多半是 auto 的前置没满足。 */
  auto = false,
): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code !== "") {
    if (code === "bad_request" && auto) return t("coordinator.error.auto");
    if (KNOWN_ERRORS.has(code)) return t(`coordinator.error.${code}`);
    return code;
  }
  return fallback;
}

/** 候选「结果」列的拒绝原因码 → 短标签；认不出就是码本身。 */
export function reasonText(code: string, t: Translate): string {
  const key = `coordinator.intake.reason.${code}`;
  const text = t(key);
  return text === key ? code : text;
}
