import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/cn";
import { Progress, progressToneFor, type ProgressTone } from "@/ui/progress";
import { Tray, TrayCard, TrayHeader, TrayTrend, TrayValue } from "@/ui/tray";

/**
 * 设置页的 KPI 托盘网格（设计系统 §5.17）：`auto-fit` 最窄 200，间距 8；手机宽度自然
 * 落成单列。没有数值型数据的页不放托盘。
 */
export function SettingsKpiGrid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="settings-kpi-grid"
      className={cn(
        "grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-2",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** 阈值色：≥ 80 warn、≥ 95 danger，其余品牌色（同 `progressToneFor`）。 */
export function kpiToneFor(percent: number | null | undefined): ProgressTone {
  return percent === null || percent === undefined || !Number.isFinite(percent)
    ? "brand"
    : progressToneFor(percent);
}

/**
 * 一张托盘：托盘头（图标 + 标签 + 可选动作）→ 内卡（大数字 → 刻度 → 一行元信息）。
 *
 * - `value` 数字用 `AnimatedNumber` 滚动，字符串（版本号、主机名）原样显示，空值 `—`；
 * - `percent` 给了才画 20 格刻度，颜色按 `tone`（缺省按阈值）；值是字符串的卡不给；
 * - `meta` 是一行 `text-meta`（窗口名、重置时间、计数说明），`trend` 只在有上一周期
 *   可比时给。
 */
export function SettingsKpi({
  icon,
  label,
  value,
  format,
  unit,
  percent,
  tone,
  meta,
  trend,
  actions,
  className,
  ...rest
}: Omit<ComponentProps<"section">, "children" | "title"> & {
  icon?: ReactNode;
  label: string;
  value: number | string | null | undefined;
  format?: (value: number) => string;
  unit?: string;
  percent?: number | null;
  tone?: ProgressTone;
  meta?: ReactNode;
  trend?: number | null;
  actions?: ReactNode;
}) {
  const hasTicks =
    percent !== null && percent !== undefined && Number.isFinite(percent);
  const hasTrend =
    trend !== null && trend !== undefined && Number.isFinite(trend);
  return (
    <Tray data-slot="settings-kpi" className={className} {...rest}>
      <TrayHeader icon={icon} label={label} actions={actions} />
      <TrayCard>
        <TrayValue
          label={label}
          value={value}
          {...(format === undefined ? {} : { format })}
          {...(unit === undefined ? {} : { unit })}
        />
        {hasTicks && (
          <Progress
            variant="ticks"
            value={percent}
            tone={tone ?? kpiToneFor(percent)}
            aria-label={label}
          />
        )}
        {(meta !== undefined && meta !== null && meta !== false) || hasTrend ? (
          <div className="flex min-h-4 items-center justify-between gap-2 text-meta text-muted-foreground">
            <span className="min-w-0 truncate">{meta}</span>
            {hasTrend && <TrayTrend delta={trend} />}
          </div>
        ) : null}
      </TrayCard>
    </Tray>
  );
}
