import * as React from "react";

import { useCanvasStore } from "@/store/canvas-store";

/**
 * 新建节点的入场（设计系统 §8.6）：`opacity 0 → 1 + scale 0.96 → 1`。
 *
 * 只给**画布稳定之后**才挂上来的节点：切板或首次载入时几十个节点一起挂载，
 * 一起弹出来是噪音（也让终端在缩放中被量尺寸）。所以记一个“载入时刻”——板号变了、
 * 或文档第一次到位——挂载时离它超过 {@link ENTER_SETTLE_MS} 的节点才算新建。
 */
export const ENTER_SETTLE_MS = 1500;

let settledSince = Date.now();

// 单测常把 `canvas-store` 整个替换成只有选择器的桩，那时没有 `subscribe`，跳过即可
if (typeof useCanvasStore.subscribe === "function") {
  useCanvasStore.subscribe((state, previous) => {
    if (
      state.boardId !== previous.boardId ||
      (previous.document === null && state.document !== null)
    ) {
      settledSince = Date.now();
    }
  });
}

/** 此刻挂载的节点算不算新建的（纯函数，测试用）。 */
export function isFreshMount(
  now: number,
  since: number = settledSince,
): boolean {
  return now - since > ENTER_SETTLE_MS;
}

/** 测试用：把“载入时刻”挪到过去或现在。 */
export function setSettledSince(at: number): void {
  settledSince = at;
}

/** 这个节点挂载那一刻是不是新建的；之后不再变（重渲不重放入场）。 */
export function useNodeEntering(): boolean {
  const [entering] = React.useState(() => isFreshMount(Date.now()));
  return entering;
}
