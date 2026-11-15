/**
 * 非 GitHub 平台答复的公共拆解：远端给什么都先过这里，长度有上限、类型不对就
 * 落到空值，网页地址只认 http(s)。Gitea 与 GitLab 共用。
 */

import { MAX_NUMBER, forgeError } from "./types";

export function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

/** 只认 http(s) 的网页地址；别的协议（`javascript:`…）丢掉。 */
export function webUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  return /^https?:\/\//i.test(value) ? value.slice(0, 2048) : "";
}

export function numbered(number: number): number {
  if (!Number.isSafeInteger(number) || number <= 0 || number > MAX_NUMBER) {
    throw forgeError("invalid", "NUMBER_INVALID");
  }
  return number;
}

/** 取出每页条数：列表参数里的 `limit`，不对就缺省。 */
export function pageSize(limit: number, fallback: number, max: number): number {
  return limit > 0 && limit <= max ? limit : fallback;
}

/** 六位十六进制颜色（去掉 `#`）；不是就 `null`。 */
export function hexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const hex = value.replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : null;
}

/** 登录名数组（`[{login}]` 一类），去空、去重、有上限。 */
export function names(
  values: unknown,
  pick: (item: unknown) => string,
): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const item of values) {
    const name = pick(item);
    if (name !== "" && !out.includes(name)) out.push(name);
    if (out.length >= 50) break;
  }
  return out;
}

/** 受限并发地跑一批活，结果与输入同序；单个失败要在 `work` 里自己接住。 */
export async function pool<T, R>(
  items: readonly T[],
  size: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from(
    { length: Math.min(size, items.length) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await work(items[index] as T, index);
      }
    },
  );
  await Promise.all(lanes);
  return results;
}
