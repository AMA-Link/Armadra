import { LOCAL_SOURCE_ID } from "@/api/source";
import { useAccess } from "@/app/use-access";
import { useCanvasStore } from "@/store/canvas-store";

/**
 * 能不能分享打开着的这块工作空间：只有主人，且它在这台电脑上（别人分享来的、
 * 我另一台电脑上的都不在这台 core 上，链接也就发不出去）。
 */
export function useCanShareCurrent(): boolean {
  const { member } = useAccess();
  const workspace = useCanvasStore((state) => state.workspace);
  const sourceId = useCanvasStore((state) => state.sourceId);
  return !member && workspace !== null && sourceId === LOCAL_SOURCE_ID;
}
