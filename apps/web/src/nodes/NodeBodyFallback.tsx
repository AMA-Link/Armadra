import { useT } from "@/app/preferences-store";
import { DeferredSkeleton } from "@/loading/DeferredSkeleton";
import { SkeletonNodeBody } from "@/ui/skeletons";
import type { CanvasNodeType } from "@armadra/shared";

/** 各种节点体的占位行数：终端与会话少，编辑器多，其余居中。 */
const LINES: Partial<Record<CanvasNodeType, number>> = {
  terminal: 3,
  editor: 6,
  browser: 5,
  files: 6,
  diff: 5,
};

/**
 * 节点体分块还在下载时的占位（`React.Suspense` 的 fallback，设计系统 §5.16）。
 * 分块 200 ms 内到位就不显示（以不可见方式占位）；挂起期间才挂载，所以阶段以 `true` 起算。
 */
export function NodeBodyFallback({ type }: { type: CanvasNodeType }) {
  const t = useT();
  return (
    <DeferredSkeleton className="h-full w-full">
      <SkeletonNodeBody lines={LINES[type] ?? 3} label={t("state.loading")} />
    </DeferredSkeleton>
  );
}
