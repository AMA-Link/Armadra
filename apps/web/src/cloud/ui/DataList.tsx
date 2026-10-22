import * as React from "react";

import { cn } from "@/lib/cn";
import { useCompactLayout } from "@/platform/layout";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from "@/ui/item";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/table";

/**
 * 一列的定义，两种渲染共用（云端控制台 §4.1）：
 * - `primary`：行的名字；窄屏是第一行左端。
 * - `trailing`：窄屏第一行右端（状态之类）。
 * - `secondary`（缺省）：窄屏折进第二行，11px 弱色，用「·」隔开。
 */
export interface DataColumn<T> {
  readonly id: string;
  readonly header: string;
  readonly cell: (row: T) => React.ReactNode;
  readonly role?: "primary" | "secondary" | "trailing";
  /** 数字列：等宽数字、右对齐。 */
  readonly numeric?: boolean;
}

export interface DataListProps<T> {
  /** 表格的 `caption`（读屏用，不画出来），也是列表的名字。 */
  readonly caption: string;
  readonly rows: readonly T[];
  readonly columns: readonly DataColumn<T>[];
  readonly rowKey: (row: T) => string;
  /** 行尾的动作（最多一个 ghost，其余收进菜单），两种渲染同一份。 */
  readonly actions?: (row: T) => React.ReactNode;
  /** 动作列的读屏列头。 */
  readonly actionsHeader?: string;
  /** 强制一种渲染；缺省 ≥768 表格、≤767 列表。 */
  readonly layout?: "table" | "list";
}

export function DataList<T>({
  caption,
  rows,
  columns,
  rowKey,
  actions,
  actionsHeader,
  layout,
}: DataListProps<T>) {
  const compact = useCompactLayout();
  const list = (layout ?? (compact ? "list" : "table")) === "list";
  if (rows.length === 0) return null;
  if (!list) {
    return (
      <Table>
        <TableCaption className="sr-only">{caption}</TableCaption>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead
                key={column.id}
                className={cn(column.numeric && "text-end")}
              >
                {column.header}
              </TableHead>
            ))}
            {actions ? (
              <TableHead className="w-0">
                <span className="sr-only">{actionsHeader}</span>
              </TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={rowKey(row)} className="h-11">
              {columns.map((column) => (
                <TableCell
                  key={column.id}
                  className={cn(column.numeric && "text-end tabular-nums")}
                >
                  {column.cell(row)}
                </TableCell>
              ))}
              {actions ? (
                <TableCell className="text-end">
                  <div className="flex items-center justify-end gap-1">
                    {actions(row)}
                  </div>
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }
  const primary = columns.find((column) => column.role === "primary");
  const trailing = columns.filter((column) => column.role === "trailing");
  const secondary = columns.filter(
    (column) => column !== primary && column.role !== "trailing",
  );
  return (
    <ItemGroup aria-label={caption} className="gap-0">
      {rows.map((row, index) => (
        <React.Fragment key={rowKey(row)}>
          {index > 0 ? <ItemSeparator className="my-0" /> : null}
          <Item role="listitem" className="flex-nowrap">
            <ItemContent>
              <ItemTitle className="w-full min-w-0 justify-between">
                <span className="min-w-0 truncate">{primary?.cell(row)}</span>
                {trailing.map((column) => (
                  <span key={column.id} className="shrink-0">
                    {column.cell(row)}
                  </span>
                ))}
              </ItemTitle>
              <SecondaryLine
                parts={secondary
                  .map((column) => [column.id, column.cell(row)] as const)
                  .filter(
                    ([, node]) => node != null && node !== false && node !== "",
                  )}
              />
            </ItemContent>
            {actions ? <ItemActions>{actions(row)}</ItemActions> : null}
          </Item>
        </React.Fragment>
      ))}
    </ItemGroup>
  );
}

/** 第二行：11px 弱色，次要列用「·」隔开；空的列不占位。 */
function SecondaryLine({
  parts,
}: {
  parts: readonly (readonly [string, React.ReactNode])[];
}) {
  if (parts.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap gap-x-1 text-[length:var(--text-caption)] text-muted-foreground tabular-nums">
      {parts.map(([id, node], at) => (
        <React.Fragment key={id}>
          {at > 0 ? <span aria-hidden>·</span> : null}
          <span className="min-w-0 truncate">{node}</span>
        </React.Fragment>
      ))}
    </div>
  );
}
