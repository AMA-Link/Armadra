import { useT } from "@/app/preferences-store";
import { DeferredSkeleton } from "@/loading/DeferredSkeleton";
import { Skeleton } from "@/ui/skeleton";
import { SKELETON_ROW, SkeletonList } from "@/ui/skeletons";
import { cn } from "@/lib/cn";

/**
 * 节点体里「首批数据还没到」的占位（设计系统 §5.16）。
 *
 * 都包在 `DeferredSkeleton` 里：200 ms 内不可见地占位，换成真内容时不跳。
 * 行高与各节点的真实行同一份：文件行与差异文件头同取 `compact`（28）。
 */

/** 文件节点的目录项行高；`FilesNode` 的真实行与这里的骨架共用。 */
export const FILES_ROW = SKELETON_ROW.compact;

const CODE_WIDTHS = ["w-2/3", "w-1/2", "w-3/5", "w-4/5", "w-2/5"] as const;

/** 代码行：左侧行号列加不同宽度的行条（编辑器读文件时）。 */
export function CodeLinesSkeleton({ lines = 6 }: { lines?: number }) {
  const t = useT();
  return (
    <DeferredSkeleton className="h-full w-full">
      <div
        data-slot="editor-loading"
        role="status"
        aria-busy="true"
        aria-label={t("state.loading")}
        className="flex gap-3 p-3"
      >
        <div className="flex flex-col gap-2">
          {Array.from({ length: lines }, (_, index) => (
            <Skeleton key={index} className="h-3 w-4" />
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {Array.from({ length: lines }, (_, index) => (
            <Skeleton
              key={index}
              className={cn("h-3", CODE_WIDTHS[index % CODE_WIDTHS.length])}
            />
          ))}
        </div>
      </div>
    </DeferredSkeleton>
  );
}

/** 目录项：图标加名字条，行高同文件节点的真实行。 */
export function FilesSkeleton({ rows = 6 }: { rows?: number }) {
  const t = useT();
  return (
    <DeferredSkeleton>
      <SkeletonList
        rows={rows}
        leading="icon"
        label={t("state.loading")}
        rowClassName={FILES_ROW}
      />
    </DeferredSkeleton>
  );
}

/** 差异：三个文件头（h-7）各接两行代码条。 */
export function DiffSkeleton({ files = 3 }: { files?: number }) {
  const t = useT();
  return (
    <DeferredSkeleton>
      <div
        role="status"
        aria-busy="true"
        aria-label={t("state.loading")}
        className="flex flex-col"
      >
        {Array.from({ length: files }, (_, index) => (
          <div key={index} className="border-b border-border">
            <div
              className={cn(
                "flex items-center gap-1.5 px-1.5",
                SKELETON_ROW.compact,
              )}
            >
              <Skeleton className="size-3.5 rounded-tight" />
              <Skeleton className="h-3 w-1/2" />
            </div>
            <div className="flex flex-col gap-1.5 px-3 pb-2">
              <Skeleton className="h-2.5 w-3/4" />
              <Skeleton className="h-2.5 w-3/5" />
            </div>
          </div>
        ))}
      </div>
    </DeferredSkeleton>
  );
}

/** 自动化卡：状态徽标条加三行 `dt/dd`，与真实卡的网格同列。 */
export function AutomationSkeleton() {
  const t = useT();
  return (
    <DeferredSkeleton>
      <div
        role="status"
        aria-busy="true"
        aria-label={t("state.loading")}
        className="space-y-2"
      >
        <Skeleton className="h-5 w-16 rounded-full" />
        <div className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {[0, 1, 2].map((row) => (
            <div key={row} className="contents">
              <Skeleton className="h-[18px] w-14" />
              <Skeleton className="h-[18px] w-2/3" />
            </div>
          ))}
        </div>
      </div>
    </DeferredSkeleton>
  );
}
