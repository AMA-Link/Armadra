/**
 * 正在就地编辑的白板对象（文字正文或形状标签）。
 *
 * 模块级单例：编辑覆盖层订阅它显示 `<textarea>`，种类的 `paint` 读它跳过那一段
 * 文字，免得 Canvas 上的字与覆盖层里的字叠成重影。
 */

export interface TextEditing {
  /** 引擎实体 id（`wb:<id>`）。 */
  id: string;
  field: "text" | "label";
}

let current: TextEditing | null = null;
const listeners = new Set<() => void>();

export const getEditing = (): TextEditing | null => current;

export function setEditing(next: TextEditing | null): void {
  if (current?.id === next?.id && current?.field === next?.field) return;
  current = next;
  for (const listener of [...listeners]) listener();
}

export function subscribeEditing(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
