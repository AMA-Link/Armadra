import { Suspense, type ReactNode } from "react";

import { useT } from "@/app/preferences-store";
import { DeferredSkeleton } from "@/loading/DeferredSkeleton";
import { Skeleton } from "@/ui/skeleton";
import { SkeletonList } from "@/ui/skeletons";
import { cn } from "cn";

/**
 * 浮层分块还在下载时的占位（设计系统 §5.16）：按浮层的外形画一块壳，里面几行骨架。
 * 分块 200 ms 内到位就什么都不画；这里的 fallback 只在 Suspense 挂起时才挂载，
 * 所以阶段以 `true` 起算。
 */
export type OverlayShape = "dialog" | "drawer" | "window";

const SHELL: Record<OverlayShape, string> = {
  dialog:
    "top-1/2 left-1/2 h-[min(60dvh,28rem)] w-[min(calc(100vw-32px),32rem)] -translate-x-1/2 -translate-y-1/2 rounded-dialog",
  drawer:
    "top-0 right-0 bottom-0 w-[min(100vw,var(--drawer-w))] border-l border-border",
  window: "right-0 bottom-0 left-0 h-[var(--git-window-h)]",
};

function OverlaySkeleton({ shape }: { shape: OverlayShape }) {
  const t = useT();
  return (
    <DeferredSkeleton hidden>
      <div
        data-slot="overlay-skeleton"
        data-shape={shape}
        className={cn(
          "pointer-events-none fixed z-[var(--z-dialog)] flex flex-col gap-2 border border-border bg-popover p-3 shadow-overlay",
          SHELL[shape],
        )}
      >
        <Skeleton className="h-4 w-1/3" />
        <SkeletonList rows={5} leading="icon" label={t("state.loading")} />
      </div>
    </DeferredSkeleton>
  );
}

/** 每个浮层自己一层 Suspense：互不阻塞，壳形与各自的外形一致。 */
export function OverlaySuspense({
  shape,
  children,
}: {
  shape: OverlayShape;
  children: ReactNode;
}) {
  return (
    <Suspense fallback={<OverlaySkeleton shape={shape} />}>{children}</Suspense>
  );
}
