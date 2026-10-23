/** 设备码（user_code）的字母表：去掉容易看混的字符（云端 `auth.deviceStart`，8 位，分两组）。 */
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const USER_CODE_LENGTH = 8;

/** 输入框里能出现的字符：粘贴时去掉空白、连字符等一切不在字母表里的，转大写，最多 8 位。 */
export function cleanUserCode(raw: string): string {
  return [...raw.toUpperCase()]
    .filter((char) => USER_CODE_ALPHABET.includes(char))
    .slice(0, USER_CODE_LENGTH)
    .join("");
}

/**
 * 输入 → 发给云端的 `XXXX-XXXX`。容忍小写、空白与缺连字符；含字母表之外的字符或长度不对
 * 是 `null`（页面当「设备码不正确」，不发请求）。
 */
export function normalizeUserCode(
  raw: string | null | undefined,
): string | null {
  const compact = (raw ?? "").toUpperCase().replace(/[\s-]/g, "");
  if (compact.length !== USER_CODE_LENGTH) return null;
  if (![...compact].every((char) => USER_CODE_ALPHABET.includes(char)))
    return null;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}
