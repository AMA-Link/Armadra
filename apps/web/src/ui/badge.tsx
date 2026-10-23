import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/cn";

/**
 * 徽标（设计系统 §9）。两档：`sm` 18（`text-caption`，节点头胶囊、表格内、`StatusPill`）
 * 与 `md` 20（`text-meta`，默认）；`rounded-pill`、等宽数字。
 * 变体：default（品牌实底）/ secondary / outline / ghost / destructive / link，
 * 另有软底三色 success / warn / brand（`-soft` 底 + `-text` 字，叠上去对比度都 ≥ 4.5）。
 */
const badgeVariants = cva(
  "group/badge inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-pill border border-transparent font-medium whitespace-nowrap tabular-nums transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        destructive:
          "bg-danger-soft text-danger-text focus-visible:ring-destructive/20 [a]:hover:bg-danger/20",
        outline:
          "border-border-strong text-foreground [a]:hover:bg-hover [a]:hover:text-foreground",
        ghost: "[a]:hover:bg-hover [a]:hover:text-foreground",
        link: "text-brand-text underline-offset-4 [a]:hover:underline",
        success: "bg-success-soft text-success-text [a]:hover:bg-success/20",
        warn: "bg-warn-soft text-warn-text [a]:hover:bg-warn/20",
        brand: "bg-brand-soft text-brand-text [a]:hover:bg-brand/20",
      },
      size: {
        sm: "h-[18px] px-1.5 text-caption",
        md: "h-5 px-2 text-meta",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "md",
    },
  },
);

function Badge({
  className,
  variant = "default",
  size = "md",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      data-size={size}
      className={cn(badgeVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
