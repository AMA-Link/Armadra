import * as React from "react";
import { ArrowDownRightIcon, ArrowUpRightIcon } from "lucide-react";

import { cn } from "@/lib/cn";
import { AnimatedNumber } from "@/ui/animated-number";
import { Card } from "@/ui/card";

/**
 * KPI 托盘（设计系统 §3.3 / §5.17）：外层 `--panel` + 1px 边 + `rounded-float` + `p-1.5`
 * 的「托盘」，里面坐一到几张 `TrayCard`（`Card variant="tray"`，`p-3`）。
 *
 * ```tsx
 * <Tray>
 *   <TrayHeader icon={<ActivityIcon />} label="Claude" actions={<IconButton … />} />
 *   <TrayCard>
 *     <TrayValue label="Claude" value={82} format={(v) => `${v}%`} fromZero />
 *     <Progress variant="ticks" value={82} tone={progressToneFor(82)} />
 *     <div className="flex items-center justify-between text-meta text-muted-foreground">
 *       <span>5 小时</span><TrayTrend delta={15.2} />
 *     </div>
 *   </TrayCard>
 * </Tray>
 * ```
 *
 * 没有数值型数据的页不放托盘；值是字符串（版本号、主机名）的托盘不画刻度。
 */
function Tray({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      data-slot="tray"
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-float border border-border bg-panel p-1.5",
        className,
      )}
      {...props}
    />
  );
}

/** 托盘头：图标 14 + `text-meta` 标签 + 右侧动作槽（24 高）。 */
function TrayHeader({
  icon,
  label,
  actions,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  icon?: React.ReactNode;
  label: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div
      data-slot="tray-header"
      className={cn(
        "flex h-6 items-center gap-1.5 px-1.5 text-meta text-muted-foreground [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {actions}
    </div>
  );
}

/** 托盘内卡：`Card variant="tray"`，`rounded-card`、四周 `p-3`（Card 自己只给上下）、行间距 8。 */
function TrayCard({
  className,
  ...props
}: Omit<React.ComponentProps<typeof Card>, "variant">) {
  return (
    <Card
      variant="tray"
      data-slot="tray-card"
      className={cn("min-w-0 gap-2 px-3", className)}
      {...props}
    />
  );
}

/** 空值 / 非有限值显示的占位。 */
const EMPTY_VALUE = "—";

/**
 * 大数字：`text-display`（22/600）等宽，数字用 `AnimatedNumber` 滚动。`value` 为字符串
 * （版本号、主机名）时原样显示；`null` / `undefined` / `NaN` 显示 `—`，不渲染 `NaN`。
 * 外包 `dl / dt / dd`：`label` 是读屏用的名字（`sr-only` 的 `dt`）。
 */
function TrayValue({
  label,
  value,
  format = (number) => new Intl.NumberFormat().format(number),
  unit,
  fromZero = true,
  className,
}: {
  label: string;
  value: number | string | null | undefined;
  format?: (value: number) => string;
  unit?: string;
  fromZero?: boolean;
  className?: string;
}) {
  const numeric = typeof value === "number" && Number.isFinite(value);
  return (
    <dl data-slot="tray-value-group" className="m-0 min-w-0">
      <dt className="sr-only">{label}</dt>
      <dd
        data-slot="tray-value"
        className={cn(
          "m-0 truncate font-mono text-display font-semibold",
          className,
        )}
      >
        {numeric ? (
          <AnimatedNumber
            value={value}
            format={format}
            fromZero={fromZero}
            {...(unit === undefined ? {} : { unit })}
          />
        ) : typeof value === "string" && value !== "" ? (
          value
        ) : (
          EMPTY_VALUE
        )}
      </dd>
    </dl>
  );
}

/**
 * 趋势：箭头 + 增减百分比，涨 `--success-text`、跌 `--danger-text`（`invert` 反过来，
 * 如费用）。只在有上一周期可比时出现：`delta` 为空 / 非有限值时什么也不画。
 * 箭头 `aria-hidden`，文字含正负号。
 */
function TrayTrend({
  delta,
  invert = false,
  className,
}: {
  delta: number | null | undefined;
  invert?: boolean;
  className?: string;
}) {
  if (delta === null || delta === undefined || !Number.isFinite(delta))
    return null;
  const up = delta >= 0;
  const good = invert ? !up : up;
  const Arrow = up ? ArrowUpRightIcon : ArrowDownRightIcon;
  const text = `${up ? "+" : "−"}${new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
  }).format(Math.abs(delta))}%`;
  return (
    <span
      data-slot="tray-trend"
      data-direction={up ? "up" : "down"}
      className={cn(
        "inline-flex items-center gap-0.5 font-mono text-meta tabular-nums",
        good ? "text-success-text" : "text-danger-text",
        className,
      )}
    >
      <Arrow aria-hidden className="size-3" />
      {text}
    </span>
  );
}

export { Tray, TrayCard, TrayHeader, TrayTrend, TrayValue };
