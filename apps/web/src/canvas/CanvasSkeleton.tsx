import { useT } from "@/app/preferences-store";
import { Skeleton } from "@/ui/skeleton";
import { cn } from "cn";

/**
 * 画布首屏骨架（设计系统 §5.16）：点阵底加几块节点形占位，盖在画布区上。
 *
 * 工作空间还没就位时（`chrome`）顺带画出工具簇与 Dock 的位置——有工作空间之后
 * 这两块是真的，不再重复画。点阵与节点壳的颜色走画布令牌，明暗主题都对得上。
 */

/** 节点形占位：标题条加正文行；位置与大小用百分比，随画布区伸缩。 */
const NODES = [
  { style: { left: "8%", top: "14%", width: "30%", height: "34%" }, lines: 4 },
  { style: { left: "46%", top: "10%", width: "24%", height: "26%" }, lines: 3 },
  { style: { left: "30%", top: "56%", width: "34%", height: "26%" }, lines: 3 },
] as const;

export function CanvasSkeleton({ chrome = false }: { chrome?: boolean }) {
  const t = useT();
  return (
    <div
      data-slot="canvas-skeleton"
      role="status"
      aria-busy="true"
      aria-label={t("state.loading")}
      className="pointer-events-none absolute inset-0 z-[var(--z-pills)] overflow-hidden bg-[var(--canvas-bg)]"
      style={{
        backgroundImage:
          "radial-gradient(circle, var(--canvas-dot) 1px, transparent 1px)",
        backgroundSize: "20px 20px",
      }}
    >
      {NODES.map((node, index) => (
        <div
          key={index}
          data-slot="canvas-skeleton-node"
          className="absolute flex flex-col overflow-hidden rounded-[var(--r-card)] border border-border bg-card"
          style={node.style}
        >
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
            <Skeleton className="size-4 rounded-sm" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <div className="flex flex-col gap-2 p-3">
            {Array.from({ length: node.lines }, (_, line) => (
              <Skeleton
                key={line}
                className={cn(
                  "h-3",
                  line % 3 === 0 ? "w-3/4" : line % 3 === 1 ? "w-1/2" : "w-2/3",
                )}
              />
            ))}
          </div>
        </div>
      ))}
      {chrome ? (
        <>
          <Skeleton className="absolute top-[14px] right-[14px] h-9 w-40 rounded-[var(--r-panel)]" />
          <Skeleton className="absolute bottom-[calc(14px+var(--safe-bottom))] left-1/2 h-[var(--dock-h)] w-64 -translate-x-1/2 rounded-[var(--r-panel)]" />
        </>
      ) : null}
    </div>
  );
}
