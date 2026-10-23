import { cn } from "@/lib/cn";

/**
 * 快捷键提示（设计系统 §3.1）：20 高，按钮与 Tooltip 内收成 16；`rounded-tight`、
 * `--surface-raised` 底、`text-caption` 500 等宽。Tooltip 里反色；实底按钮里
 * 用按钮自己的文字色叠一层半透明——只认外层按钮自己的变体（`group/button`），不会被
 * 带 `data-variant` 的 `Card` 等祖先染色。
 */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-tight bg-raised px-1 font-mono text-caption font-medium text-muted-foreground select-none",
        "in-data-[slot=button]:h-4 in-data-[slot=button]:min-w-4 in-data-[slot=tooltip-content]:h-4 in-data-[slot=tooltip-content]:min-w-4",
        "in-data-[slot=tooltip-content]:bg-background/20 in-data-[slot=tooltip-content]:text-background",
        "group-data-[variant=default]/button:bg-primary-foreground/20 group-data-[variant=default]/button:text-primary-foreground group-data-[variant=destructive-solid]/button:bg-primary-foreground/20 group-data-[variant=destructive-solid]/button:text-primary-foreground",
        "[&_svg:not([class*='size-'])]:size-3",
        className,
      )}
      {...props}
    />
  );
}

function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  );
}

export { Kbd, KbdGroup };
