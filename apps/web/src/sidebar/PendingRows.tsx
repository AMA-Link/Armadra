import { useT } from "@/app/preferences-store";
import { useSkeletonPhase } from "@/loading/use-skeleton-phase";
import { SkeletonList } from "@/ui/skeletons";
import { cn } from "cn";

/**
 * 侧栏树里还在等数据的那几行（设计系统 §5.16）。
 *
 * 行高与真实的工作空间行 / 画布行同一档（`compact`，h-7），缩进也一样，
 * 数据一到就原地换成真行，不推挤上下。200 ms 内以不可见方式占位，
 * 有缓存时 `loading` 为假，根本不出现。
 */
export function PendingRows({
  loading,
  rows,
  indent = false,
}: {
  loading: boolean;
  rows: number;
  /** 画布行的缩进（与 `BoardRow` 的 `indent` 一致）。 */
  indent?: boolean;
}) {
  const t = useT();
  const phase = useSkeletonPhase(loading);
  if (phase === "idle") return null;
  return (
    <li
      data-slot="tree-pending"
      data-phase={phase}
      className={cn(phase === "hold" && "invisible")}
    >
      <SkeletonList
        rows={rows}
        size="compact"
        leading="icon"
        label={t("state.loading")}
        rowClassName={indent ? "pr-1 pl-4" : "pr-1 pl-1.5"}
      />
    </li>
  );
}
