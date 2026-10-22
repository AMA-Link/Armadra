import { useT } from "@/app/preferences-store";
import { CanvasSkeleton } from "../canvas/CanvasSkeleton";
import { SkeletonList } from "@/ui/skeletons";
import { Skeleton } from "@/ui/skeleton";
import { cn } from "cn";

/**
 * 整页骨架：与 `AppShell` 同布局（左侧栏加右侧画布），身份查询未回时代替空白。
 * `hidden` 为真时占位但不可见（骨架的 200 ms 延迟内），免得先白一下再出现。
 */
export function AppSkeleton({ hidden = false }: { hidden?: boolean }) {
  const t = useT();
  return (
    <div
      data-slot="app-skeleton"
      className={cn(
        "flex h-full overflow-hidden bg-background pt-[var(--safe-top)] pr-[var(--safe-right)] pl-[var(--safe-left)]",
        hidden && "invisible",
      )}
    >
      <aside className="material-sidebar hidden h-full w-[var(--sidebar-w)] shrink-0 flex-col gap-2 border-r border-border p-2 md:flex">
        <div className="flex h-9 items-center px-2">
          <Skeleton className="h-4 w-28" />
        </div>
        <SkeletonList rows={4} leading="icon" label={t("state.loading")} />
      </aside>
      <main className="workspace-surface relative min-w-0 flex-1">
        <CanvasSkeleton chrome />
      </main>
    </div>
  );
}
