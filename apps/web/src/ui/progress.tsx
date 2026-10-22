import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Progress as ProgressPrimitive } from "radix-ui";

import { cn } from "@/lib/cn";

/** 指示条的颜色：默认品牌，`warn` / `danger` 给配额接近与用尽（云端控制台 §4.2）。 */
const indicatorVariants = cva("size-full flex-1 transition-all", {
  variants: {
    tone: {
      default: "bg-primary",
      warn: "bg-warn",
      danger: "bg-danger",
    },
  },
  defaultVariants: { tone: "default" },
});

function Progress({
  className,
  value,
  tone = "default",
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> &
  VariantProps<typeof indicatorVariants>) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      data-tone={tone}
      className={cn(
        "relative flex h-1 w-full items-center overflow-x-hidden rounded-full bg-muted",
        className,
      )}
      value={value}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={indicatorVariants({ tone })}
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress };
