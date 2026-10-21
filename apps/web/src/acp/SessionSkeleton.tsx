import { Skeleton } from "@/ui/skeleton";

/**
 * 会话体的占位：代码块（`SessionView` 懒加载）加载期间不留空白，形状与时间线的
 * 骨架一致，换成真内容时不跳。
 */
export function SessionSkeleton() {
  return (
    <div
      data-slot="acp-session-skeleton"
      className="flex h-full w-full flex-col gap-3 bg-[var(--card)] p-3"
    >
      <Skeleton className="h-4 w-2/3 self-end" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}
