import type { ReactNode } from "react";

import { useT } from "@/app/preferences-store";
import { Loadable } from "@/loading/Loadable";
import { Skeleton } from "@/ui/skeleton";
import { Card } from "@/ui/card";
import { SkeletonSettings, SkeletonTable } from "@/ui/skeletons";
import { SettingsGroup } from "./SettingsGroup";

/**
 * 设置还没到时，用与 `SettingsRow` 同高的行骨架占位（开关 / 选择器 / 输入各取控件形状），
 * 到了再换成真控件；200 ms 内到的不出骨架（§5.16）。`loading` 只在没有可显示的设置时为真。
 */
export function SettingsLoadable({
  loading,
  rows = 1,
  control = "input",
  grouped = false,
  title,
  children,
}: {
  loading: boolean;
  rows?: number;
  control?: "switch" | "input" | "select";
  /** 整组缺席的位置：骨架自带一张 `SettingsGroup` 卡片，内容那边自己也是一组。 */
  grouped?: boolean;
  /** `grouped` 的卡片小标题。 */
  title?: string;
  children: ReactNode;
}) {
  const t = useT();
  const skeleton = (
    <SkeletonSettings
      className="divide-y divide-border/60"
      rows={rows}
      control={control}
      label={t("state.loading")}
    />
  );
  return (
    <Loadable
      loading={loading}
      skeleton={
        grouped ? (
          <SettingsGroup {...(title === undefined ? {} : { title })}>
            {skeleton}
          </SettingsGroup>
        ) : (
          skeleton
        )
      }
    >
      {children}
    </Loadable>
  );
}

/**
 * 行内数值 / 文本位：未到时画一条 `Skeleton`（默认 h-4 w-12），到了换成真值；
 * 200 ms 内到的不出骨架。`className` 只管骨架条的宽；行内的条不朗读（行标签仍在），免得一页里冒出一串 status。
 */
export function ValueLoadable({
  loading,
  className = "h-4 w-12",
  children,
}: {
  loading: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Loadable
      loading={loading}
      skeleton={<Skeleton aria-hidden className={className} />}
    >
      {children}
    </Loadable>
  );
}

/**
 * 设置页里 `Card` + `Table` 的占位：卡片壳、表头 h-10、行 h-11，与真实表格（`TableHead` /
 * `TableCell` 的 p-2）同高；`title` 给就带上分组小标题。
 */
export function TableCardSkeleton({
  rows = 3,
  columns = 3,
  title,
}: {
  rows?: number;
  columns?: number;
  title?: string;
}) {
  const t = useT();
  const card = (
    <Card className="gap-0 overflow-visible rounded-lg border border-border/70 px-2 py-0 text-[length:inherit] ring-0">
      <SkeletonTable
        rows={rows}
        columns={columns}
        label={t("state.loading")}
        className="[&_[data-slot=skeleton-table-head]]:h-10 [&_[data-slot=skeleton-table-row]]:h-11"
      />
    </Card>
  );
  if (title === undefined) return card;
  return (
    <section className="flex min-w-0 flex-col gap-(--space-group)">
      <h3 className="px-0.5 text-[13px] font-medium">{title}</h3>
      {card}
    </section>
  );
}
