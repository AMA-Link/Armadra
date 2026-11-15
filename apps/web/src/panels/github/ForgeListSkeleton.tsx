import { Skeleton } from "@/ui/skeleton";

/** 与 `Row` 同样的边框、圆角与内边距：编号条、标题条、徽标，下面一行元信息。 */
export function ForgeListSkeleton({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      data-slot="forge-list-skeleton"
      className="min-w-0 space-y-1.5 p-(--space-page)"
    >
      {[0, 1, 2, 3, 4].map((index) => (
        <div
          key={index}
          className="flex min-h-14 min-w-0 flex-col gap-1 rounded-card border border-border px-3 py-2"
        >
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-8 shrink-0" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="ml-auto h-5 w-12 shrink-0 rounded-full" />
          </div>
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}
