import * as React from "react";
import { Dialog as SheetPrimitive } from "radix-ui";

import { cn } from "@/lib/cn";
import { Button } from "@/ui/button";
import { rubberBand } from "@/ui/motion";
import { XIcon } from "lucide-react";

function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetPortal({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        "motion-overlay fixed inset-0 z-(--z-dialog) bg-scrim supports-backdrop-filter:backdrop-blur-xs",
        className,
      )}
      {...props}
    />
  );
}

/**
 * 抽屉贴着屏幕边缘：底色铺到边上，内容让开它贴着的那几条边的安全区与窗口控件
 * （设计系统 §3.1）。调用方自己给了同一方向的内边距（`p-0`、`pt-…`）就用调用方的。
 */
const SAFE_PADDING = {
  top: "pt-[var(--overlay-inset-top)] pr-[var(--safe-right)] pl-[var(--safe-left)]",
  right: "pt-[var(--safe-top)] pr-[var(--safe-right)] pb-[var(--safe-bottom)]",
  bottom:
    "pr-[var(--safe-right)] pb-[var(--safe-bottom)] pl-[var(--safe-left)]",
  left: "pt-[var(--overlay-inset-top)] pb-[var(--safe-bottom)] pl-[var(--safe-left)]",
} as const;

/** 关闭钮跟着让开：贴着顶边的抽屉往下，贴着右边的往左。 */
const SAFE_CLOSE = {
  top: "top-[calc(0.75rem+var(--overlay-inset-top))] right-[calc(0.75rem+var(--safe-right))]",
  right:
    "top-[calc(0.75rem+var(--safe-top))] right-[calc(0.75rem+var(--safe-right))]",
  bottom: "top-3 right-[calc(0.75rem+var(--safe-right))]",
  left: "top-[calc(0.75rem+var(--overlay-inset-top))] right-3",
} as const;

/** 甩出的速度阈值（px/ms）：超过它即关闭，不要求拖过距离阈值。 */
const FLICK_VELOCITY = 0.11;
/** 拖过内容高度的这个比例也关闭。 */
const DISMISS_RATIO = 0.4;

/**
 * 底部 Sheet 的拖柄（设计系统 §8.3）：向下拖 1:1 跟手，`setPointerCapture`，忽略第二根手指，
 * 速度 > 0.11 px/ms 或拖过 40% 即关闭，向上拖有递增阻力，松手没到阈值就回弹到原位（无过冲）。
 */
function SheetHandle({
  target,
  onDismiss,
}: {
  target: React.RefObject<HTMLElement | null>;
  onDismiss: () => void;
}) {
  const drag = React.useRef<{
    id: number;
    startY: number;
    lastY: number;
    lastT: number;
    velocity: number;
  } | null>(null);

  const move = (dy: number) => {
    const el = target.current;
    if (!el) return;
    el.style.transition = "none";
    el.style.transform = `translateY(${dy >= 0 ? dy : -rubberBand(-dy)}px)`;
  };

  return (
    <div
      data-slot="sheet-handle"
      className="absolute inset-x-0 top-0 flex h-5 touch-none items-start justify-center pt-1.5"
      onPointerDown={(event) => {
        if (drag.current) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          id: event.pointerId,
          startY: event.clientY,
          lastY: event.clientY,
          lastT: event.timeStamp,
          velocity: 0,
        };
      }}
      onPointerMove={(event) => {
        const state = drag.current;
        if (!state || event.pointerId !== state.id) return;
        const dt = Math.max(1, event.timeStamp - state.lastT);
        state.velocity = (event.clientY - state.lastY) / dt;
        state.lastY = event.clientY;
        state.lastT = event.timeStamp;
        move(event.clientY - state.startY);
      }}
      onPointerUp={(event) => {
        const state = drag.current;
        if (!state || event.pointerId !== state.id) return;
        drag.current = null;
        const el = target.current;
        const dy = event.clientY - state.startY;
        const height = el?.getBoundingClientRect().height ?? 0;
        if (
          state.velocity > FLICK_VELOCITY ||
          (height > 0 && dy > height * DISMISS_RATIO)
        ) {
          onDismiss();
          return;
        }
        if (el) {
          el.style.transition = "transform var(--dur-base) var(--ease-out)";
          el.style.transform = "";
        }
      }}
      onPointerCancel={() => {
        drag.current = null;
        const el = target.current;
        if (el) {
          el.style.transition = "transform var(--dur-base) var(--ease-out)";
          el.style.transform = "";
        }
      }}
    >
      <span className="block h-1 w-9 rounded-pill bg-border-strong" />
    </div>
  );
}

function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: "top" | "right" | "bottom" | "left";
  showCloseButton?: boolean;
}) {
  const content = React.useRef<HTMLDivElement>(null);
  const closer = React.useRef<HTMLButtonElement>(null);
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        ref={content}
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          SAFE_PADDING[side],
          "motion-sheet fixed z-(--z-dialog) flex flex-col gap-4 bg-popover bg-clip-padding text-body text-popover-foreground shadow-dialog data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:rounded-t-dialog data-[side=bottom]:border-t data-[side=bottom]:border-border-strong data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r data-[side=left]:border-border-strong data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l data-[side=right]:border-border-strong data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b data-[side=top]:border-border-strong data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm",
          className,
        )}
        {...props}
      >
        {side === "bottom" && (
          <>
            <SheetHandle
              target={content}
              onDismiss={() => closer.current?.click()}
            />
            <SheetPrimitive.Close
              ref={closer}
              tabIndex={-1}
              aria-hidden
              className="sr-only"
            />
          </>
        )}
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close data-slot="sheet-close" asChild>
            <Button
              variant="ghost"
              className={cn("absolute", SAFE_CLOSE[side])}
              size="icon-sm"
            >
              <XIcon />
              <span className="sr-only">Close</span>
            </Button>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-0.5 p-4", className)}
      {...props}
    />
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  );
}

function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn(
        "font-heading text-title font-semibold text-strong",
        className,
      )}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-body text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
