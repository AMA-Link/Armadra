import * as React from "react";
import { useViewport } from "@xyflow/react";

/**
 * 当前画布缩放（Dock 的档位、浏览器节点的右键菜单坐标）。
 *
 * 缺省读 React Flow 的视口；自研引擎在位时由 `board/` 把它的相机缩放推进来
 * （{@link publishBoardZoom}），优先于 React Flow 的值。必须在
 * `<ReactFlowProvider>` 之下调用。
 */
let boardZoom: number | null = null;
const listeners = new Set<() => void>();

export function publishBoardZoom(zoom: number | null): void {
  if (boardZoom === zoom) return;
  boardZoom = zoom;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCanvasZoom(): number {
  const flowZoom = useViewport().zoom;
  const own = React.useSyncExternalStore(
    subscribe,
    () => boardZoom,
    () => null,
  );
  return own ?? flowZoom;
}
