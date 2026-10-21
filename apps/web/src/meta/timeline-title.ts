import * as React from "react";

import { usePreferencesStore } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { canAutoTitle, rememberAutoTitle } from "./auto-title";

/**
 * 时间线头部的 `title` 作节点名（契约 §82.3、设计 §10 Q5）。
 *
 * 规则与 `autoNameNode` 同一套账本（`auto-title.ts`）：只在 `autoTitle` 打开时
 * 应用；只在标题仍是占位、或上一次自动命名写的时才覆盖，人工改过名就锁定；
 * 头部 `title` 为空或只有空白不处理；标题没变不写，重复调用幂等。
 * 写入走 `updateNode`，进撤销栈与别的改名一致；来源记进账本，之后的 OSC 标题
 * 不会冲掉它。
 *
 * 返回是否写了标题。
 */
export function applyTimelineTitle(
  nodeId: string,
  headTitle: string | null | undefined,
): boolean {
  if (!usePreferencesStore.getState().autoTitle) return false;
  const title = (headTitle ?? "").trim();
  if (title === "") return false;
  const store = useCanvasStore.getState();
  const node = store.document?.nodes.find((item) => item.id === nodeId);
  if (!node || node.type !== "terminal") return false;
  if (!canAutoTitle(node)) return false;
  const next = title.slice(0, 160);
  if (node.title.trim() === next) {
    // 已经是这个名：只把来源记成自动，别的什么都不动。
    rememberAutoTitle(nodeId, next);
    return false;
  }
  rememberAutoTitle(nodeId, next);
  store.updateNode(nodeId, { title: next });
  return true;
}

/** 头部 `title` 一变（或节点换了）就按上面的规则应用一次。 */
export function useTimelineTitle(
  nodeId: string,
  headTitle: string | null | undefined,
): void {
  React.useEffect(() => {
    applyTimelineTitle(nodeId, headTitle);
  }, [nodeId, headTitle]);
}
