import type { ReactNode } from "react";

import { useT } from "../../app/preferences-store";
import { Loadable } from "../../loading/Loadable";
import { Skeleton } from "../../ui/skeleton";

/**
 * Git 面板里「首批数据还没到」的占位。三种形状，行高与真实内容同一份常量：
 * - `list`：文件 / 提交 / reflog 一类列表行，`GIT_ROW`（28px）；
 * - `code`：补丁与片段，`text-caption leading-4` 的代码行（`GIT_CODE_LINE`，16px）；
 * - `blocks`：整块（片段卡片、提交摘要）。
 * 套在 `Loadable` 里：200 ms 内不可见占位，之后才显示，换成内容时高度不变。
 */
export const GIT_ROW = "h-[28px]";
export const GIT_CODE_LINE = "h-4";

const WIDTHS = ["w-2/3", "w-1/2", "w-3/4", "w-2/5", "w-3/5"] as const;

export function GitListSkeleton({
  rows = 4,
  label,
}: {
  rows?: number;
  label: string;
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      data-slot="git-list-skeleton"
      className="flex min-w-0 flex-col"
    >
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          data-slot="git-skeleton-row"
          className={`flex min-w-0 items-center gap-2 px-1 ${GIT_ROW}`}
        >
          <Skeleton className="size-3 shrink-0 rounded-tight" />
          <Skeleton className={`h-3 ${WIDTHS[index % WIDTHS.length]}`} />
        </div>
      ))}
    </div>
  );
}

export function GitCodeSkeleton({
  lines = 6,
  label,
}: {
  lines?: number;
  label: string;
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      data-slot="git-code-skeleton"
      className="flex min-w-0 flex-col gap-0 rounded-control bg-muted p-2"
    >
      {Array.from({ length: lines }, (_, index) => (
        <div key={index} className={`flex items-center ${GIT_CODE_LINE}`}>
          <Skeleton
            className={`h-2.5 bg-background/60 ${WIDTHS[(index * 2) % WIDTHS.length]}`}
          />
        </div>
      ))}
    </div>
  );
}

export function GitBlocksSkeleton({
  blocks = 2,
  label,
}: {
  blocks?: number;
  label: string;
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      data-slot="git-blocks-skeleton"
      className="flex min-w-0 flex-col gap-2"
    >
      {Array.from({ length: blocks }, (_, index) => (
        <Skeleton key={index} className="h-16 w-full rounded-control" />
      ))}
    </div>
  );
}

export function GitLoadable({
  loading,
  kind = "list",
  size,
  children,
}: {
  loading: boolean;
  kind?: "list" | "code" | "blocks";
  /** 行数 / 行数 / 块数。 */
  size?: number;
  children?: ReactNode;
}) {
  const t = useT();
  const label = t("state.loading");
  const skeleton =
    kind === "code" ? (
      <GitCodeSkeleton label={label} {...(size ? { lines: size } : {})} />
    ) : kind === "blocks" ? (
      <GitBlocksSkeleton label={label} {...(size ? { blocks: size } : {})} />
    ) : (
      <GitListSkeleton label={label} {...(size ? { rows: size } : {})} />
    );
  return (
    <Loadable loading={loading} skeleton={skeleton}>
      {children ?? null}
    </Loadable>
  );
}
