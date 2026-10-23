import * as React from "react";
import { ArrowDown, ArrowUp, Cable } from "lucide-react";

import { useT } from "../app/preferences-store";
import { formatBytes } from "../lib/format";
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Button } from "@/ui/button";
import { Progress } from "@/ui/progress";
import { EmptyState } from "@/ui/state";
import { Tray, TrayCard, TrayValue } from "@/ui/tray";

/** 一行分项：类别或对端。`up` 是本机发出的，`down` 是收到的。 */
export interface TrafficBreakdownRow {
  readonly key: string;
  readonly label: string;
  readonly up: number;
  readonly down: number;
}

export interface TrafficBreakdownProps {
  readonly up: number;
  readonly down: number;
  readonly streams: number;
  readonly rows: readonly TrafficBreakdownRow[];
  /** 给了才有「清零」；确认框的标题。 */
  readonly clearTitle?: string;
  readonly onClear?: () => void;
  /** 与「清零」同一行、靠右的控件（保留期之类）。 */
  readonly footer?: React.ReactNode;
}

/**
 * 流量的三格（上行 · 下行 · 连接）与按分项的比例条，底部「清零」（契约 §76，
 * 设计 §6.6）。客户端自己的计量与远程访问页里 core 的统计都用它。
 */
export function TrafficBreakdown({
  up,
  down,
  streams,
  rows,
  clearTitle,
  onClear,
  footer,
}: TrafficBreakdownProps) {
  const t = useT();
  const [confirming, setConfirming] = React.useState(false);
  const sorted = React.useMemo(
    () =>
      [...rows]
        .filter((row) => row.up + row.down > 0)
        .sort((a, b) => b.up + b.down - (a.up + a.down)),
    [rows],
  );
  const largest = sorted[0] ? sorted[0].up + sorted[0].down : 0;
  const empty = up === 0 && down === 0 && streams === 0;

  return (
    <div
      data-slot="traffic-breakdown"
      className="flex flex-col gap-(--space-section)"
    >
      <Tray className="grid grid-cols-3">
        <Cell
          icon={<ArrowUp />}
          label={t("traffic.up")}
          value={formatBytes(up)}
          slot="up"
        />
        <Cell
          icon={<ArrowDown />}
          label={t("traffic.down")}
          value={formatBytes(down)}
          slot="down"
        />
        <Cell
          icon={<Cable />}
          label={t("traffic.streams")}
          value={String(streams)}
          slot="streams"
        />
      </Tray>
      {empty ? (
        <EmptyState title={t("traffic.empty")} className="py-6" />
      ) : (
        <ul className="flex flex-col gap-3" aria-label={t("traffic.title")}>
          {sorted.map((row) => {
            const total = row.up + row.down;
            return (
              <li
                key={row.key}
                data-traffic-row={row.key}
                className="flex flex-col gap-1.5"
              >
                <div className="flex items-baseline justify-between gap-3 text-body">
                  <span className="min-w-0 truncate">{row.label}</span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {formatBytes(total)}
                  </span>
                </div>
                <Progress
                  value={largest > 0 ? (total / largest) * 100 : 0}
                  aria-label={row.label}
                />
              </li>
            );
          })}
        </ul>
      )}
      {((onClear && !empty) || footer !== undefined) && (
        <div className="flex items-center justify-between gap-2">
          {onClear && !empty ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              // 幽灵按钮的文字与上面的分项左对齐。
              className="-ml-2.5"
              onClick={() => setConfirming(true)}
            >
              {t("traffic.clear")}
            </Button>
          ) : (
            <span />
          )}
          {footer}
        </div>
      )}
      <ResponsiveAlertDialog open={confirming} onOpenChange={setConfirming}>
        <ResponsiveAlertDialogContent>
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              {clearTitle ?? t("traffic.clear")}
            </ResponsiveAlertDialogTitle>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>
              {t("traffic.cancel")}
            </ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              variant="destructive-solid"
              onClick={() => {
                onClear?.();
                setConfirming(false);
              }}
            >
              {t("traffic.clear")}
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </div>
  );
}

function Cell({
  icon,
  label,
  value,
  slot,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  slot: string;
}) {
  return (
    <TrayCard data-traffic-cell={slot} className="gap-1">
      <span
        aria-hidden
        className="flex items-center text-muted-foreground [&_svg]:size-3.5"
      >
        {icon}
      </span>
      <TrayValue label={label} value={value} fromZero={false} />
    </TrayCard>
  );
}
