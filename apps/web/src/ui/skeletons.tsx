import * as React from "react";
import { cn } from "cn";

import { Skeleton } from "@/ui/skeleton";

/**
 * 通用骨架（设计系统 §5.16）：列表行、卡片、表格、表单行、节点体、时间线回合。
 *
 * 尺寸与真实内容对齐：行高取自下面的 `SKELETON_ROW` 档位，与 `Item` / 设置行 / 表格行
 * 的真实高度一致，宽度用固定的比例序列（不随机），所以内容换进来时容器不变高、不跳。
 * 每个骨架自带 `role="status"` 与 `aria-busy`；`label` 是读屏用的名字，不渲染成可见文字。
 */

/** 行高档位：与真实行同一份（compact 文件树、default 列表与设置行、tall 两行条目）。 */
export const SKELETON_ROW = {
  compact: "h-7",
  default: "h-8",
  tall: "h-10",
} as const;
export type SkeletonRowSize = keyof typeof SKELETON_ROW;

/** 条宽序列：循环取用，让相邻行长短错开又每次渲染一致。 */
const WIDTHS = ["w-2/3", "w-1/2", "w-3/4", "w-2/5", "w-3/5"] as const;
const width = (index: number) => WIDTHS[index % WIDTHS.length];

type RegionProps = {
  /** 读屏名字（已本地化）；不给就不朗读。 */
  label?: string;
  className?: string;
};

function Region({
  label,
  className,
  slot,
  children,
  ...rest
}: RegionProps & {
  slot: string;
  children: React.ReactNode;
} & Omit<React.ComponentProps<"div">, "children" | "className">) {
  return (
    <div
      data-slot={slot}
      role="status"
      aria-busy="true"
      {...(label === undefined ? { "aria-hidden": true } : { "aria-label": label })}
      className={className}
      {...rest}
    >
      {children}
    </div>
  );
}

/* ---------------------------------- 列表行 --------------------------------- */

export type SkeletonRowProps = {
  size?: SkeletonRowSize;
  /** 行首：圆点 / 头像 / 图标方块。 */
  leading?: "none" | "dot" | "avatar" | "icon";
  /** 第二行次要文字（tall 行常用）。 */
  secondary?: boolean;
  /** 行尾一枚小控件。 */
  trailing?: boolean;
  /** 第几行：只用来错开宽度。 */
  index?: number;
  className?: string;
};

export function SkeletonRow({
  size = "default",
  leading = "none",
  secondary = false,
  trailing = false,
  index = 0,
  className,
}: SkeletonRowProps) {
  return (
    <div
      data-slot="skeleton-row"
      data-size={size}
      className={cn(
        "flex items-center gap-2 px-2",
        SKELETON_ROW[secondary && size === "default" ? "tall" : size],
        className,
      )}
    >
      {leading === "dot" ? <Skeleton className="size-2 rounded-full" /> : null}
      {leading === "icon" ? <Skeleton className="size-4 rounded-sm" /> : null}
      {leading === "avatar" ? (
        <Skeleton className="size-6 rounded-[var(--r-pill)]" />
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Skeleton className={cn("h-3", width(index))} />
        {secondary ? <Skeleton className="h-2.5 w-1/3" /> : null}
      </div>
      {trailing ? <Skeleton className="h-4 w-8 shrink-0" /> : null}
    </div>
  );
}

export function SkeletonList({
  rows = 3,
  label,
  className,
  ...row
}: RegionProps & { rows?: number } & Omit<SkeletonRowProps, "index" | "className"> & {
    rowClassName?: string;
  }) {
  const { rowClassName, ...rowProps } = row;
  return (
    <Region label={label} slot="skeleton-list" className={cn("flex flex-col", className)}>
      {Array.from({ length: rows }, (_, index) => (
        <SkeletonRow
          key={index}
          index={index}
          {...rowProps}
          {...(rowClassName === undefined ? {} : { className: rowClassName })}
        />
      ))}
    </Region>
  );
}

/* ----------------------------------- 卡片 ---------------------------------- */

export function SkeletonCard({
  lines = 2,
  header = true,
  label,
  className,
}: RegionProps & { lines?: number; header?: boolean }) {
  return (
    <Region
      label={label}
      slot="skeleton-card"
      className={cn(
        "flex flex-col gap-3 rounded-[var(--r-card)] border border-border bg-card p-4",
        className,
      )}
    >
      {header ? <Skeleton className="h-4 w-1/3" /> : null}
      <div className="flex flex-col gap-2">
        {Array.from({ length: lines }, (_, index) => (
          <Skeleton key={index} className={cn("h-3", index === 0 ? "w-full" : width(index))} />
        ))}
      </div>
    </Region>
  );
}

/* ----------------------------------- 表格 ---------------------------------- */

export function SkeletonTable({
  rows = 5,
  columns = 4,
  header = true,
  label,
  className,
}: RegionProps & { rows?: number; columns?: number; header?: boolean }) {
  const grid = { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` };
  return (
    <Region label={label} slot="skeleton-table" className={cn("flex flex-col", className)}>
      {header ? (
        <div
          data-slot="skeleton-table-head"
          className="grid h-8 items-center gap-3 border-b border-border px-3"
          style={grid}
        >
          {Array.from({ length: columns }, (_, column) => (
            <Skeleton key={column} className="h-3 w-1/2" />
          ))}
        </div>
      ) : null}
      {Array.from({ length: rows }, (_, row) => (
        <div
          key={row}
          data-slot="skeleton-table-row"
          className="grid h-9 items-center gap-3 px-3"
          style={grid}
        >
          {Array.from({ length: columns }, (_, column) => (
            <Skeleton key={column} className={cn("h-3", width(row + column))} />
          ))}
        </div>
      ))}
    </Region>
  );
}

/* ----------------------------------- 表单 ---------------------------------- */

/** 设置页的一行：左标签（含次要行）+ 右控件；`control` 选控件的形状。 */
export function SkeletonSettingsRow({
  control = "input",
  index = 0,
  className,
}: {
  control?: "switch" | "input" | "select";
  index?: number;
  className?: string;
}) {
  return (
    <div
      data-slot="skeleton-settings-row"
      className={cn("flex h-12 items-center justify-between gap-4 px-3", className)}
    >
      <Skeleton className={cn("h-3.5", width(index))} />
      {control === "switch" ? (
        <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
      ) : (
        <Skeleton
          className={cn("h-8 shrink-0", control === "select" ? "w-32" : "w-48")}
        />
      )}
    </div>
  );
}

/** 表单：标签条 + 控件条，竖排；控件高度同 `Input`（h-8）。 */
export function SkeletonForm({
  rows = 3,
  label,
  className,
}: RegionProps & { rows?: number }) {
  return (
    <Region label={label} slot="skeleton-form" className={cn("flex flex-col gap-4", className)}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex flex-col gap-1.5">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-8 w-full" />
        </div>
      ))}
    </Region>
  );
}

/** 设置页一组：若干 `SkeletonSettingsRow`。 */
export function SkeletonSettings({
  rows = 3,
  control = "input",
  label,
  className,
}: RegionProps & { rows?: number; control?: "switch" | "input" | "select" }) {
  return (
    <Region label={label} slot="skeleton-settings" className={cn("flex flex-col", className)}>
      {Array.from({ length: rows }, (_, index) => (
        <SkeletonSettingsRow key={index} index={index} control={control} />
      ))}
    </Region>
  );
}

/* ---------------------------------- 节点体 --------------------------------- */

/** 画布节点的内容区：与节点体同样 `p-3`、撑满父级；不带边框，边框归节点壳。 */
export function SkeletonNodeBody({
  lines = 4,
  label,
  className,
}: RegionProps & { lines?: number }) {
  return (
    <Region
      label={label}
      slot="skeleton-node-body"
      className={cn("flex h-full w-full flex-col gap-2 bg-[var(--card)] p-3", className)}
    >
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className={cn("h-3", index === 0 ? "w-1/3" : width(index))} />
      ))}
    </Region>
  );
}

/* --------------------------------- 时间线回合 -------------------------------- */

/** 会话时间线的占位回合：一句用户话（右）+ 助手两三行（左）。 */
export function SkeletonTurns({
  turns = 1,
  label,
  className,
}: RegionProps & { turns?: number }) {
  return (
    <Region
      label={label}
      slot="skeleton-turns"
      className={cn("flex flex-col gap-3 p-3", className)}
    >
      {Array.from({ length: turns }, (_, index) => (
        <React.Fragment key={index}>
          <Skeleton className="h-4 w-2/3 self-end" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-1/2" />
        </React.Fragment>
      ))}
    </Region>
  );
}
