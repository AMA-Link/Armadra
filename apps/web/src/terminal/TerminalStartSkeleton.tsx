import { useT } from "@/app/preferences-store";
import { DeferredSkeleton } from "@/loading/DeferredSkeleton";
import { TERMINAL_PADDING } from "@/nodes/geometry";
import { Skeleton } from "@/ui/skeleton";

/**
 * 终端首帧输出到之前的占位（设计系统 §5.16）：盖在 xterm 容器上的几条低对比度行条。
 * 终端底色由主题决定，所以行条用终端前景色（`--term-fg`）的低透明度，而不是固定灰。
 * 连接建立前（`starting` / `connecting`）才挂，200 ms 内不可见，不挡输入。
 */
export function TerminalStartSkeleton() {
  const t = useT();
  return (
    <div
      data-slot="terminal-start-skeleton"
      className="pointer-events-none absolute inset-0"
      style={{ padding: TERMINAL_PADDING }}
    >
      <DeferredSkeleton hidden>
        <div
          role="status"
          aria-busy="true"
          aria-label={t("state.loading")}
          className="flex flex-col gap-2"
        >
          <Skeleton className="h-3 w-2/3 bg-[color-mix(in_srgb,var(--term-fg)_14%,transparent)]" />
          <Skeleton className="h-3 w-1/2 bg-[color-mix(in_srgb,var(--term-fg)_14%,transparent)]" />
          <Skeleton className="h-3 w-1/4 bg-[color-mix(in_srgb,var(--term-fg)_14%,transparent)]" />
        </div>
      </DeferredSkeleton>
    </div>
  );
}
