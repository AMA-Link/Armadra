import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/cn";
import { Kbd } from "@/ui/kbd";
import { ariaKeyShortcuts } from "@/ui/kbd-format";
import { Shimmer } from "@/ui/shimmer";
import { Spinner } from "@/ui/spinner";

/**
 * 按钮（设计系统 §9）。控件高度五档：xs 24 · sm 28 · default 32 · lg 36 · touch 44，
 * 圆角一律 `rounded-control`（6）；同一行里的控件取同一档，功能代码不手写高度。
 * 主按钮是品牌蓝实底（一屏一个）；次要 `outline`，行内 `ghost`，危险确认
 * `destructive-solid`。
 *
 * 状态：悬停 `--dur-instant`（只在有悬停的设备上）；按下 `scale(0.97)`（`motion-press`，
 * `static` 关掉）；`aria-expanded` 保持 hover 底；`loading` 见下。
 */
const buttonVariants = cva(
  "group/button motion-press inline-flex shrink-0 items-center justify-center rounded-control border border-transparent bg-clip-padding text-body font-medium whitespace-nowrap outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        outline:
          "border-border-strong bg-card text-foreground hover:bg-hover aria-expanded:bg-hover",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-expanded:bg-secondary/80",
        ghost:
          "hover:bg-hover hover:text-foreground aria-expanded:bg-hover aria-expanded:text-foreground",
        destructive:
          "bg-danger-soft text-danger-text hover:bg-danger/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20",
        "destructive-solid":
          "bg-danger-solid text-primary-foreground hover:bg-danger-solid/90 focus-visible:ring-destructive/30",
        link: "text-brand-text underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 px-1.5 text-meta has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 px-2 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        touch:
          "h-11 gap-2 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        icon: "size-8",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-lg": "size-9",
        "icon-touch": "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

/** 转圈的两档：xs / sm / 图标小钮用 12，其余 16。 */
function spinnerSizeOf(size: ButtonSize): 12 | 16 {
  return size === "xs" ||
    size === "sm" ||
    size === "icon-xs" ||
    size === "icon-sm"
    ? 12
    : 16;
}

/** 去掉带 `data-icon="inline-start"` 的前导图标，loading 时由 `Spinner` 顶替。 */
function withoutLeadingIcon(children: React.ReactNode): React.ReactNode {
  return React.Children.toArray(children).filter(
    (child) =>
      !(
        React.isValidElement<{ "data-icon"?: string }>(child) &&
        child.props["data-icon"] === "inline-start"
      ),
  );
}

export interface ButtonProps
  extends React.ComponentProps<"button">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /**
   * 进行中：前导图标换成 `Spinner`（图标要标 `data-icon="inline-start"`，没标就在最前面
   * 补一枚），标签叠 `Shimmer`，宽度不变。写 `aria-busy` 而不是 `disabled`——仍可聚焦，
   * 点击被吞掉。`asChild` 下只写属性。
   */
  loading?: boolean;
  /** 关掉按下缩放（行内大面积可点区域、已经有自己动画的钮）。 */
  static?: boolean;
  /**
   * 尾部的快捷键提示（`Kbd` 16 高），如 `↵`、`⌘K`；同时写 `aria-keyshortcuts`。
   * 只负责显示——键位的登记与派发在 `keybindings/`，显示串用 `formatKeys` 取。
   */
  shortcut?: string;
}

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  loading = false,
  static: isStatic = false,
  shortcut,
  children,
  onClick,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  const resolvedSize = size ?? "default";

  let inner: React.ReactNode = children;
  if (!asChild && (loading || shortcut !== undefined)) {
    inner = (
      <>
        {loading && (
          <Spinner
            size={spinnerSizeOf(resolvedSize)}
            data-icon="inline-start"
          />
        )}
        {loading ? (
          <Shimmer className="inline-flex items-center gap-[inherit]">
            {withoutLeadingIcon(children)}
          </Shimmer>
        ) : (
          children
        )}
        {shortcut !== undefined && <Kbd>{shortcut}</Kbd>}
      </>
    );
  }

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-static={isStatic ? "true" : undefined}
      data-loading={loading ? "true" : undefined}
      aria-busy={loading ? true : undefined}
      aria-keyshortcuts={
        shortcut === undefined ? undefined : ariaKeyShortcuts(shortcut)
      }
      className={cn(buttonVariants({ variant, size, className }))}
      onClick={
        loading
          ? (event: React.MouseEvent<HTMLButtonElement>) => {
              // loading 不 disabled（仍可聚焦），但点击不再触发动作
              event.preventDefault();
            }
          : onClick
      }
      {...props}
    >
      {inner}
    </Comp>
  );
}

export { Button, buttonVariants };
