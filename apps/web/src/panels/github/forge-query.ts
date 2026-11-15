import type { ForgeListState, ForgeSort } from "../../api/forge";

/**
 * 搜索框里的限定词串（`is:open label:core author:x 全文`）与筛选下拉互相同步的
 * 纯函数：下拉写限定词，搜索框改了限定词下拉跟着变。限定词的写法与托管平台
 * 网页一致，含空格的值加引号。
 */

const QUOTE = String.fromCharCode(34);

export type ForgeQualifier =
  "author" | "label" | "milestone" | "review" | "assignee" | "is";

// 按空白切词，引号里的空白不切；引号本身保留在词里。
export function tokenize(query: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of query) {
    if (char === QUOTE) quoted = !quoted;
    if (!quoted && /\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith(QUOTE) && value.endsWith(QUOTE)
    ? value.slice(1, -1)
    : value;
}

function quote(value: string): string {
  const bare = value.split(QUOTE).join("");
  return /\s/.test(bare) || bare !== value ? `${QUOTE}${bare}${QUOTE}` : bare;
}

function split(token: string): { key: string; value: string } | null {
  const at = token.indexOf(":");
  if (at <= 0) return null;
  return {
    key: token.slice(0, at).toLowerCase(),
    value: unquote(token.slice(at + 1)),
  };
}

// 某个限定词的全部值，按出现顺序。
export function qualifierValues(query: string, key: ForgeQualifier): string[] {
  return tokenize(query).flatMap((token) => {
    const parsed = split(token);
    return parsed && parsed.key === key && parsed.value ? [parsed.value] : [];
  });
}

// 把某个限定词整体换成 `values`（空数组即去掉），其余词原样保留。
export function setQualifier(
  query: string,
  key: ForgeQualifier,
  values: readonly string[],
): string {
  const kept = tokenize(query).filter((token) => split(token)?.key !== key);
  return [...kept, ...values.map((value) => `${key}:${quote(value)}`)]
    .join(" ")
    .trim();
}

// 多值限定词（标签）里切换一个值。
export function toggleQualifier(
  query: string,
  key: ForgeQualifier,
  value: string,
): string {
  const current = qualifierValues(query, key);
  return setQualifier(
    query,
    key,
    current.includes(value)
      ? current.filter((entry) => entry !== value)
      : [...current, value],
  );
}

// 搜索串里 `is:open|closed|merged` 优先于状态切换（计划：core 同样处理）。
export function stateFromQuery(query: string): ForgeListState | null {
  const value = qualifierValues(query, "is").find((entry) =>
    ["open", "closed", "merged"].includes(entry),
  );
  if (value === "open") return "open";
  if (value === "closed" || value === "merged") return "closed";
  return null;
}

// 排序下拉的选项：排序字段加方向。
export const SORT_CHOICES = [
  { id: "updated-desc", sort: "updated", direction: "desc" },
  { id: "updated-asc", sort: "updated", direction: "asc" },
  { id: "created-desc", sort: "created", direction: "desc" },
  { id: "created-asc", sort: "created", direction: "asc" },
  { id: "comments-desc", sort: "comments", direction: "desc" },
] as const satisfies readonly {
  id: string;
  sort: ForgeSort;
  direction: "asc" | "desc";
}[];

export type ForgeSortId = (typeof SORT_CHOICES)[number]["id"];

export const REVIEW_CHOICES = [
  "approved",
  "changes_requested",
  "required",
  "none",
] as const;
