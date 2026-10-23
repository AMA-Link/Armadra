"use client";

import * as React from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";

import { cn } from "@/lib/cn";
import { Kbd } from "@/ui/kbd";
import { useOverlayCollisionPadding } from "@/ui/safe-area";

function TooltipProvider({
  // 首次延迟 500ms，指针扫过工具簇时不会一路弹提示；300ms 内移到邻近的下一个
  // 立即打开且无动画（Radix 给 `data-state="instant-open"`，motion.css 渲染终态）
  delayDuration = 500,
  skipDelayDuration = 300,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...props}
    />
  );
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  collisionPadding,
  shortcut,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content> & {
  /** 这个动作的快捷键（给人看的写法，如 `⌘K`），以反色 `Kbd` 跟在文案后面。 */
  shortcut?: string;
}) {
  const padding = useOverlayCollisionPadding(collisionPadding);
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        collisionPadding={padding}
        sideOffset={sideOffset}
        className={cn(
          "motion-tip z-(--z-dialog) inline-flex w-fit max-w-60 origin-(--radix-tooltip-content-transform-origin) items-center gap-1.5 rounded-control bg-foreground px-2 py-1 text-caption font-medium text-background has-data-[slot=kbd]:pr-1.5 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-(--z-dialog)",
          className,
        )}
        {...props}
      >
        {children}
        {shortcut !== undefined && <Kbd>{shortcut}</Kbd>}
        <TooltipPrimitive.Arrow className="z-(--z-dialog) size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-tight bg-foreground fill-foreground" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
