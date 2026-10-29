import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import { Card } from "@/ui/card";

/**
 * 设置页里的一张分组卡片（设计系统 §5.17）。
 *
 * 卡片用 `Card` 自己的圆角与 1px 边，不再覆盖样式；内部的行由 `divide-y` 分隔，
 * 行本身不画线。可选的 `title` 是 `text-body` 500 的小标题，贴在卡片上方，只在一页里
 * 有多张卡片、需要区分时才给。
 */
export function SettingsGroup({
  title,
  children,
  className,
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-(--space-group)", className)}>
      {title && (
        <h3 className="px-0.5 text-body font-medium text-foreground">
          {title}
        </h3>
      )}
      <Card className="settings-group gap-0 py-0 divide-y divide-border-soft overflow-visible">
        {children}
      </Card>
    </section>
  );
}
