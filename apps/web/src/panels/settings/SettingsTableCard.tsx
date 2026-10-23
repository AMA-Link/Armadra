import type { ReactNode } from "react";

import { useT } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import { Card, CardHeader, CardTitle } from "@/ui/card";
import { useRoving } from "@/ui/roving";
import { SkeletonTable } from "@/ui/skeletons";
import { EmptyState } from "@/ui/state";
import { Tabs, TabsList, TabsTrigger } from "@/ui/tabs";

export interface SettingsTableFilter<V extends string = string> {
  value: V;
  onValueChange: (value: V) => void;
  /** 至多 4 项。 */
  options: ReadonlyArray<{ value: V; label: string }>;
  /** 分段控件的读屏名。 */
  label: string;
}

/**
 * 表格卡（设计系统 §5.17）：`Card variant="table"`，头行 = 标题 + 分段筛选（≤ 4 项）+
 * 「查看全部」；内容是一张 `Table`（表头 32、行 36、数字列右对齐等宽、状态列
 * `StatusPill sm`、末列动作 `IconButton inline`）。
 *
 * - `loading`：整块换成 `SkeletonTable`（行高与真实行一致，200 ms 内到的由调用方用
 *   `Loadable` 包住不出骨架）；
 * - `empty`：卡内 `EmptyState`，一句名词短语，可带一个动作；
 * - 行内的主动作标 `data-roving-item`，↑↓ 在行间移动。
 */
export function SettingsTableCard<V extends string = string>({
  title,
  filter,
  viewAll,
  actions,
  loading = false,
  empty,
  skeleton,
  children,
  ...rest
}: {
  title: string;
  filter?: SettingsTableFilter<V>;
  viewAll?: { onClick: () => void; label?: string };
  actions?: ReactNode;
  loading?: boolean;
  empty?: { title: string; action?: ReactNode } | null;
  skeleton?: { rows?: number; columns?: number };
  children?: ReactNode;
} & Omit<React.ComponentProps<"div">, "title" | "children">) {
  const t = useT();
  const roving = useRoving<HTMLDivElement>();
  return (
    <Card variant="table" data-slot="settings-table-card" {...rest}>
      <CardHeader className="flex items-center gap-2">
        <CardTitle className="min-w-0 flex-1 truncate">{title}</CardTitle>
        {filter && (
          <Tabs
            value={filter.value}
            onValueChange={(value) => filter.onValueChange(value as V)}
          >
            <TabsList variant="segmented" size="sm" aria-label={filter.label}>
              {filter.options.map((option) => (
                <TabsTrigger key={option.value} value={option.value}>
                  {option.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}
        {actions}
        {viewAll && (
          <Button variant="link" size="sm" onClick={viewAll.onClick}>
            {viewAll.label ?? t("settings.table.viewAll")}
          </Button>
        )}
      </CardHeader>
      {loading ? (
        <SkeletonTable
          rows={skeleton?.rows ?? 4}
          columns={skeleton?.columns ?? 4}
          label={t("state.loading")}
        />
      ) : empty ? (
        <EmptyState title={empty.title} className="border-0 p-6">
          {empty.action}
        </EmptyState>
      ) : (
        <div {...roving}>{children}</div>
      )}
    </Card>
  );
}
