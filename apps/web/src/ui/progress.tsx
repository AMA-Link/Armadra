import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Progress as ProgressPrimitive } from "radix-ui";

import { cn } from "@/lib/cn";

/**
 * 指示条的颜色（设计系统 §9）：`default`（= 主色）/ `brand`（`--brand`）/ `warn` / `danger` /
 * `success`。`warn` / `danger` 给配额接近与用尽（云端控制台 §4.2）。
 */
const toneVariants = cva("", {
  variants: {
    tone: {
      default: "bg-primary",
      brand: "bg-brand",
      warn: "bg-warn",
      danger: "bg-danger",
      success: "bg-success",
    },
  },
  defaultVariants: { tone: "default" },
});

export type ProgressTone = NonNullable<
  VariantProps<typeof toneVariants>["tone"]
>;

/** 阈值色调（设计系统 §5.17）：≥ 80% warn，≥ 95% danger，其余品牌色。 */
export function progressToneFor(percent: number): ProgressTone {
  if (percent >= 95) return "danger";
  if (percent >= 80) return "warn";
  return "brand";
}

/** 刻度条的格数。 */
export const TICK_COUNT = 20;

const clamp = (value: number) => Math.min(100, Math.max(0, value));

/**
 * 进度。`bar`（4px 条）首次出现从 0 填到当前值（`--dur-page` 线性）；`ticks`（20 格，
 * 3×8，间距 2）逐格点亮，未填格是 `--faint` 30%；`value` 不传 / 为空 = 不确定，
 * 条在轨道里匀速扫过。文字值写在旁边，进度本身只给 `aria-valuenow`。
 */
function Progress({
  className,
  value,
  tone = "default",
  variant = "bar",
  ...props
}: Omit<React.ComponentProps<typeof ProgressPrimitive.Root>, "value"> &
  VariantProps<typeof toneVariants> & {
    value?: number | null;
    variant?: "bar" | "ticks";
  }) {
  // NaN / ±Infinity 当作「没有值」：边界状态里不渲染 NaN（设计系统 §12）
  const indeterminate =
    value === undefined || value === null || !Number.isFinite(value);
  const percent = indeterminate ? 0 : clamp(value);

  // 首次出现先画 0，下一次提交再换成目标值，让 CSS 过渡有起点
  const [shown, setShown] = React.useState(false);
  React.useEffect(() => setShown(true), []);

  if (variant === "ticks") {
    const filled = Math.round((percent / 100) * TICK_COUNT);
    return (
      <ProgressPrimitive.Root
        data-slot="progress"
        data-variant="ticks"
        data-tone={tone}
        className={cn("flex h-2 w-full items-center gap-0.5", className)}
        value={indeterminate ? null : percent}
        {...props}
      >
        {Array.from({ length: TICK_COUNT }, (_, index) => {
          const on = index < filled;
          return (
            <span
              key={`${index}:${on ? "on" : "off"}`}
              data-slot="progress-tick"
              data-filled={on ? "true" : "false"}
              style={{ "--i": index } as React.CSSProperties}
              className={cn(
                "h-2 w-[3px] flex-1 rounded-tight",
                on ? [toneVariants({ tone }), "anim-tick-in"] : "bg-faint/30",
              )}
            />
          );
        })}
      </ProgressPrimitive.Root>
    );
  }

  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      data-variant="bar"
      data-tone={tone}
      className={cn(
        "relative flex h-1 w-full items-center overflow-x-hidden rounded-pill bg-muted",
        className,
      )}
      value={indeterminate ? null : percent}
      {...props}
    >
      {indeterminate ? (
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          className={cn(
            "anim-indeterminate h-full w-2/5 rounded-pill",
            toneVariants({ tone }),
          )}
        />
      ) : (
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          className={cn(
            "size-full flex-1 transition-transform duration-(--dur-page) ease-linear motion-reduce:transition-none",
            toneVariants({ tone }),
          )}
          style={{
            transform: `translateX(-${100 - (shown ? percent : 0)}%)`,
          }}
        />
      )}
    </ProgressPrimitive.Root>
  );
}

export { Progress };
