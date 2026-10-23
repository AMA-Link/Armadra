/**
 * 命令面板的「最近」一组（设计系统 §11.2：最近使用置顶）。
 *
 * 只记命令表与新建菜单里的项（稳定 id）：跳转目标、历史对话、对着某个终端说的
 * 命令都随上下文变，记了也对不上。存在本机 localStorage，最多 `RECENT_MAX` 条，
 * 新的在前、同一条不重复；读不到 / 存不进去就当没有。
 */
const KEY = "armadra.palette.recent";

/** 与 ⌘1–⌘5 对齐：最近这一组最多五行，正好是快选的五个数字。 */
export const RECENT_MAX = 5;

export function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === "string")
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/** 记下刚运行的一条，返回新的列表。 */
export function rememberRecent(id: string): string[] {
  const next = [id, ...readRecent().filter((entry) => entry !== id)].slice(
    0,
    RECENT_MAX,
  );
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 存不进去：这次的最近只在内存里，不影响运行
  }
  return next;
}
