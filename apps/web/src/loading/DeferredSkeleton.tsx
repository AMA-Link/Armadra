import type { ReactNode } from "react";

import { cn } from "cn";
import { useSkeletonPhase } from "./use-skeleton-phase";

/**
 * 「挂载即在等」的骨架外壳：Suspense 的 fallback、首次挂载就等数据的区域用它。
 *
 * 200 ms 内以不可见的方式占位（高度不变，内容到了不跳），之后才显示；
 * 它卸载就是等待结束，所以阶段以 `true` 起算。`hidden` 为真时不占位，
 * 适合壳外形没法预知的浮层。
 */
export function DeferredSkeleton({
  children,
  hidden = false,
  className,
}: {
  children: ReactNode;
  hidden?: boolean;
  className?: string;
}) {
  const phase = useSkeletonPhase(true);
  if (hidden && phase !== "show") return null;
  return (
    <div
      data-slot="deferred-skeleton"
      data-phase={phase}
      className={cn(phase !== "show" && "invisible", className)}
    >
      {children}
    </div>
  );
}
