import type { ReactNode } from "react";

import { useT } from "@/app/preferences-store";
import { EmptyState, ErrorState } from "@/ui/state";
import { cn } from "cn";
import { useSkeletonPhase } from "./use-skeleton-phase";

/**
 * 统一的加载 / 错误 / 空 / 内容四态。
 *
 * - `loading`：**没有可展示数据**时才为真；有缓存先显示缓存（`loading` 传 false），后台刷新不出骨架。
 * - 骨架 200 ms 之后才显示，之前以不可见的方式占位（高度不变，内容到了不跳）；
 *   显示后至少停 300 ms。
 * - `error` 在没有内容可显示时给一条带重试的行内错误；`empty` 给一句空态。
 */
export function Loadable({
  loading,
  skeleton,
  error,
  onRetry,
  empty,
  emptyTitle,
  emptyIcon,
  inline = false,
  className,
  children,
}: {
  loading: boolean;
  skeleton: ReactNode;
  error?: unknown;
  onRetry?: () => void;
  empty?: boolean;
  emptyTitle?: string;
  emptyIcon?: ReactNode;
  inline?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const t = useT();
  const phase = useSkeletonPhase(loading);
  if (phase !== "idle") {
    return (
      <div
        data-slot="loadable"
        data-phase={phase}
        className={cn(phase === "hold" && "invisible", className)}
      >
        {skeleton}
      </div>
    );
  }
  if (error) {
    return (
      <ErrorState
        title={t("state.error")}
        retryLabel={t("state.retry")}
        inline={inline}
        {...(onRetry === undefined ? {} : { onRetry })}
        {...(className === undefined ? {} : { className })}
      />
    );
  }
  if (empty && emptyTitle !== undefined) {
    return (
      <EmptyState
        title={emptyTitle}
        inline={inline}
        {...(emptyIcon === undefined ? {} : { icon: emptyIcon })}
        {...(className === undefined ? {} : { className })}
      />
    );
  }
  return <>{children}</>;
}
