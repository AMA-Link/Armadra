import { CanvasSkeleton } from "../canvas/CanvasSkeleton";
import { useSkeletonPhase } from "../loading/use-skeleton-phase";
import { useCanvasStore } from "../store/canvas-store";
import { useBoardSync } from "./use-board-sync";

/**
 * 加载链（工作空间 → 画布列表 → 画布文档）与首批数据没到时的画布骨架。
 *
 * 单独成一个叶子：`useBoardSync` 读着工作空间列表、画布列表与文档三组查询，
 * 它们的每一次刷新（会话状态跳动时 `board.changed` 就会让画布列表重取）都会让
 * 持有它的组件重渲。住在 `AppShell` 里，代价是整个应用壳（上千个组件）陪着重渲；
 * 放在这里只重渲骨架本身。骨架 200 ms 内不出现，出现后至少停 300 ms。
 */
export function CanvasLoadGate() {
  const workspace = useCanvasStore((state) => state.workspace);
  const { canvasLoading } = useBoardSync();
  const phase = useSkeletonPhase(canvasLoading);
  return phase === "show" ? <CanvasSkeleton chrome={!workspace} /> : null;
}
