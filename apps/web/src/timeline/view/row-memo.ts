import * as React from "react";
import type { TimelineItem } from "@armadra/shared";

/**
 * 行组件的 memo：同一个条目 id 与 `rev` 就认为内容没变（设计 §4：行组件按
 * `item.rev` 做 memo）。其余 props 逐项 `Object.is`，所以回调必须稳定。
 */
export function sameRow<P extends { item: TimelineItem }>(
  a: Readonly<P>,
  b: Readonly<P>,
): boolean {
  if (a.item.id !== b.item.id || a.item.rev !== b.item.rev) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (key === "item") continue;
    if (
      !Object.is(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      )
    )
      return false;
  }
  return true;
}

export function memoRow<P extends { item: TimelineItem }>(
  component: React.FunctionComponent<P>,
): React.NamedExoticComponent<P> {
  return React.memo(component, sameRow);
}
