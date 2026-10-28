import * as React from "react";
import { HoverCard as HoverCardPrimitive } from "radix-ui";

import { cn } from "@/lib/cn";
import { useOverlayCollisionPadding } from "@/ui/safe-area";

function HoverCard({
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  return <HoverCardPrimitive.Root data-slot="hover-card" {...props} />;
}

function HoverCardTrigger({
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  return (
    <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />
  );
}

function HoverCardContent({
  className,
  align = "center",
  sideOffset = 4,
  collisionPadding,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
  const padding = useOverlayCollisionPadding(collisionPadding);
  return (
    <HoverCardPrimitive.Portal data-slot="hover-card-portal">
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        collisionPadding={padding}
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "motion-pop border border-border-strong shadow-overlay z-(--z-dialog) w-64 max-w-80 origin-(--radix-hover-card-content-transform-origin) rounded-field bg-popover p-3 text-body text-popover-foreground outline-hidden",
          className,
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  );
}

export { HoverCard, HoverCardTrigger, HoverCardContent };
