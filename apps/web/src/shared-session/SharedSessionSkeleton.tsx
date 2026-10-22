import { useT } from "@/app/preferences-store";
import { Loadable } from "@/loading/Loadable";
import { Skeleton } from "@/ui/skeleton";
import { SkeletonTurns } from "@/ui/skeletons";

/**
 * 只读查看页的占位：与 `SharedSessionPage` 同一个壳（占满画布、`h-11` 顶栏），
 * 主体是时间线回合的形状，页面下载或会话行没到时先顶着，到了不跳。
 */
export function SharedSessionBodySkeleton() {
  const t = useT();
  return (
    <div className="mx-auto h-full w-full max-w-3xl">
      <SkeletonTurns turns={2} label={t("state.loading")} />
    </div>
  );
}

export function SharedSessionSkeleton() {
  return (
    <Loadable
      loading
      skeleton={
        <section
          data-slot="shared-session-skeleton"
          className="absolute inset-0 z-[var(--z-shared-session)] flex flex-col bg-background"
        >
          <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-5 w-14 rounded-full" />
          </header>
          <div className="min-h-0 flex-1">
            <SharedSessionBodySkeleton />
          </div>
        </section>
      }
    >
      {null}
    </Loadable>
  );
}
