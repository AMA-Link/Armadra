import { useT } from "@/app/preferences-store";
import { DeferredSkeleton } from "@/loading/DeferredSkeleton";
import { SkeletonTurns } from "@/ui/skeletons";

/**
 * 会话体的占位：代码块（`SessionView` 懒加载）加载期间不留空白。
 * 形状是共享的 `SkeletonTurns`，与时间线、会话视图的加载态是同一份。
 */
export function SessionSkeleton() {
  const t = useT();
  return (
    <DeferredSkeleton className="h-full w-full bg-[var(--card)]">
      <SkeletonTurns label={t("state.loading")} />
    </DeferredSkeleton>
  );
}
