import { useStageView } from "./stage-view";

/**
 * 当前画布缩放（Dock 的档位、浏览器节点的右键菜单坐标）。读 `stage-view` 里
 * 当前引擎推进来的视口，不依赖任何一个引擎的 hook，也不需要 provider。
 */
export function useCanvasZoom(): number {
  return useStageView().zoom;
}
