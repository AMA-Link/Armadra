import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/cn";

/** 文本域：内边距、字号、圆角与下沉底跟 `Input` 同四档（最小高度由行数决定，不写死控件高度）。 */
const textareaVariants = cva(
  "flex field-sizing-content min-h-16 w-full border border-input bg-sunken text-base transition-[color,background-color,border-color] duration-(--dur-fast) outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:disabled:bg-input/80",
  {
    variants: {
      size: {
        xs: "rounded-control px-1.5 py-1 md:text-meta",
        sm: "rounded-control px-2 py-1.5 md:text-body",
        default: "rounded-field px-2.5 py-2 md:text-body",
        touch: "rounded-field px-3 py-2.5",
      },
    },
    defaultVariants: { size: "default" },
  },
);

function Textarea({
  className,
  size = "default",
  ...props
}: Omit<React.ComponentProps<"textarea">, "size"> &
  VariantProps<typeof textareaVariants>) {
  return (
    <textarea
      data-slot="textarea"
      data-size={size}
      className={cn(textareaVariants({ size }), className)}
      {...props}
    />
  );
}

export { Textarea, textareaVariants };
