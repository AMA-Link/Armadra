import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/cn";

/**
 * 输入框（设计系统 §2.13）。高度四档与 `Button` / `SelectTrigger` 同档：xs 24 · sm 28 ·
 * default 32 · touch 44。手机上字号 16px（`text-base`），防 iOS 聚焦时缩放页面；
 * `touch` 档任何视口都是 16。`aria-invalid` 时红边 + 20% 环，并抖两次（motion.css）。
 */
const inputVariants = cva(
  "w-full min-w-0 rounded-control border border-input bg-transparent text-base transition-[color,background-color,border-color] duration-(--dur-fast) outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-body file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30 dark:disabled:bg-input/80",
  {
    variants: {
      size: {
        xs: "h-6 px-1.5 py-0 md:text-meta",
        sm: "h-7 px-2 py-0.5 md:text-body",
        default: "h-8 px-2.5 py-1 md:text-body",
        touch: "h-11 px-3 py-2",
      },
    },
    defaultVariants: { size: "default" },
  },
);

function Input({
  className,
  type,
  size = "default",
  ...props
}: Omit<React.ComponentProps<"input">, "size"> &
  VariantProps<typeof inputVariants>) {
  return (
    <input
      type={type}
      data-slot="input"
      data-size={size}
      className={cn(inputVariants({ size }), className)}
      {...props}
    />
  );
}

export { Input, inputVariants };
