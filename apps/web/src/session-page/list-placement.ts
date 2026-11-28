import { useCanvasStore } from "@/store/canvas-store";
import { useCompactLayout, usePhoneLandscape } from "@/platform/layout";

/**
 * 会话列表放在侧栏里吗（#1084 第二步）：桌面上侧栏停靠展开时，侧栏就是会话
 * 模式的导航，会话页只剩详情一栏；侧栏收起、手机或手机横屏（侧栏是抽屉）时，
 * 会话页照旧自带列表。
 */
export function useSessionListInSidebar(): boolean {
  const docked = useCanvasStore((state) => state.panels.sidebar) === "open";
  const compact = useCompactLayout();
  const landscape = usePhoneLandscape();
  return docked && !compact && !landscape;
}
