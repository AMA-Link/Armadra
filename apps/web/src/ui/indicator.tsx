import * as React from "react";
import { LayoutGroup, motion } from "motion/react";

import { cn } from "@/lib/cn";
import { INDICATOR_TRANSITION } from "@/ui/motion";

/**
 * 共享指示器（设计系统 §8.4）：同一组元素的「当前项 / 悬停项」是同一块底，用 `motion`
 * 的 `layoutId` 在组内平移过去（`--dur-base` `--ease-in-out`），而不是各自变色。
 * 设置导航、分段控件、Tabs line、Dock 工具组、右上工具簇都用它。
 *
 * ```tsx
 * <IndicatorGroup id="settings-nav">
 *   {items.map((item) => (
 *     <button key={item.id} className="relative isolate" {...hoverProps(item.id)}>
 *       {item.id === current && <Indicator className="inset-0 rounded-control bg-raised" />}
 *       {item.label}
 *     </button>
 *   ))}
 * </IndicatorGroup>
 * ```
 *
 * 指示器必须放在 `relative isolate` 的项里，自己 `absolute -z-10`，文字留在上面。
 * 减少动效下（`MotionConfig reducedMotion="user"`）直接落到新位置。
 */
interface IndicatorContextValue {
  group: string;
  hovered: string | null;
  setHovered: (id: string | null) => void;
}

const IndicatorContext = React.createContext<IndicatorContextValue | null>(
  null,
);

function IndicatorGroup({
  id,
  children,
}: {
  /** 组 id；同一页面里不重名即可，不传就用 `useId`。 */
  id?: string;
  children: React.ReactNode;
}) {
  const generated = React.useId();
  const group = id ?? generated;
  const [hovered, setHovered] = React.useState<string | null>(null);
  const value = React.useMemo(
    () => ({ group, hovered, setHovered }),
    [group, hovered],
  );
  return (
    <LayoutGroup id={group}>
      <IndicatorContext.Provider value={value}>
        {children}
      </IndicatorContext.Provider>
    </LayoutGroup>
  );
}

/** 项上挂悬停处理：指针移到邻项时悬停底块平移过去，离开整组才淡出。 */
function useIndicatorHover() {
  const context = React.useContext(IndicatorContext);
  return React.useMemo(
    () => ({
      hovered: context?.hovered ?? null,
      hoverProps: (id: string) => ({
        onPointerEnter: (event: React.PointerEvent) => {
          // 触屏的 :hover 会粘住，只认鼠标 / 笔
          if (event.pointerType === "touch") return;
          context?.setHovered(id);
        },
        onPointerLeave: () => context?.setHovered(null),
      }),
    }),
    [context],
  );
}

/**
 * 一块指示器。`kind="active"`（默认）是当前项，`"hover"` 是悬停项；两种各占一个
 * `layoutId`，互不抢。放在 `IndicatorGroup` 外也能渲染（不平移）。
 */
function Indicator({
  kind = "active",
  className,
  ...props
}: Omit<
  React.ComponentProps<typeof motion.span>,
  "layoutId" | "transition" | "layout"
> & { kind?: "active" | "hover" }) {
  const context = React.useContext(IndicatorContext);
  return (
    <motion.span
      aria-hidden
      data-slot="indicator"
      data-kind={kind}
      {...(context ? { layoutId: `${context.group}:${kind}` } : {})}
      transition={INDICATOR_TRANSITION}
      className={cn("pointer-events-none absolute -z-10", className)}
      {...props}
    />
  );
}

export { Indicator, IndicatorGroup, useIndicatorHover };
