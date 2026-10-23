import * as React from "react";

import { useT } from "@/app/preferences-store";
import { cn } from "@/lib/cn";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Indicator, IndicatorGroup, useIndicatorHover } from "@/ui/indicator";
import { useRoving } from "@/ui/roving";
import { ScrollArea } from "@/ui/scroll-area";
import { StatusDot } from "@/ui/status-pill";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import type { SettingsNavGroup, SettingsSection } from "./nav";
import type { NavBadge, NavBadges } from "./nav-badges";

/**
 * 设置导航（设计系统 §5.17）：贴在窗口底上，没有卡片。
 *
 * 分组标题 `text-caption` 500，组间 `.hairline-x`；项是 28 高的 `ghost sm` 全宽按钮，当前项
 * 的 `--surface-raised` 底与悬停底都由 `ui/indicator` 在项之间平移；↑↓ Home End 在项之间
 * 移动（roving），回车打开；行尾可带计数徽标或提示点。窄栏（`narrow`）只留图标，标签进
 * Tooltip。列表溢出时用 `ScrollArea`（细滚动条，悬停或滚动时才出现），与内容区一致。
 */
export function SettingsNav({
  groups,
  active,
  onSelect,
  badges,
  narrow = false,
}: {
  groups: readonly SettingsNavGroup[];
  active: string;
  onSelect: (id: string) => void;
  badges: NavBadges;
  narrow?: boolean;
}) {
  const t = useT();
  const roving = useRoving<HTMLElement>();
  return (
    <ScrollArea className="settings-navigation-scroll h-full shrink-0">
      <nav
        aria-label={t("settings.title")}
        data-narrow={narrow ? "true" : undefined}
        className="settings-navigation flex min-h-full flex-col gap-2 p-4 pr-3"
        {...roving}
      >
        <IndicatorGroup id="settings-nav">
          {groups.map((group, index) => (
            <React.Fragment key={group.groupKey}>
              {index > 0 && <div aria-hidden className="hairline-x shrink-0" />}
              <div role="group" className="flex flex-col gap-0.5">
                <div
                  className={cn(
                    "settings-nav-group px-2 pt-1 pb-1 text-caption font-medium text-muted-foreground",
                    narrow && "sr-only",
                  )}
                >
                  {t(group.groupKey)}
                </div>
                {group.sections.map((section) => (
                  <NavItem
                    key={section.id}
                    section={section}
                    active={section.id === active}
                    badge={badges[section.id]}
                    narrow={narrow}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            </React.Fragment>
          ))}
        </IndicatorGroup>
      </nav>
    </ScrollArea>
  );
}

function NavItem({
  section,
  active,
  badge,
  narrow,
  onSelect,
}: {
  section: SettingsSection;
  active: boolean;
  badge: NavBadge | undefined;
  narrow: boolean;
  onSelect: (id: string) => void;
}) {
  const t = useT();
  const Icon = section.icon;
  const { hovered, hoverProps } = useIndicatorHover();
  const describedBy = React.useId();
  const label = t(section.labelKey);
  const button = (
    <Button
      variant="ghost"
      size="sm"
      type="button"
      data-roving-item
      data-active={active}
      aria-current={active ? "page" : undefined}
      aria-label={label}
      aria-describedby={badge ? describedBy : undefined}
      className={cn(
        "relative isolate w-full justify-start gap-2 px-2 font-normal text-muted-foreground hover:bg-transparent",
        "hover:text-foreground data-[active=true]:text-foreground",
        narrow && "justify-center px-0",
      )}
      onClick={() => onSelect(section.id)}
      {...hoverProps(section.id)}
    >
      {hovered === section.id && !active && (
        <Indicator kind="hover" className="inset-0 rounded-control bg-hover" />
      )}
      {active && <Indicator className="inset-0 rounded-control bg-raised" />}
      <Icon className="size-4 shrink-0" />
      {!narrow && (
        <span className="settings-nav-label min-w-0 flex-1 truncate text-left">
          {label}
        </span>
      )}
      {badge &&
        (badge.kind === "count" ? (
          <Badge
            id={describedBy}
            size="sm"
            variant="brand"
            data-slot="settings-nav-badge"
            className={cn(narrow && "absolute top-0.5 right-0.5 px-1")}
          >
            {badge.count}
          </Badge>
        ) : (
          <StatusDot
            id={describedBy}
            tone={badge.tone}
            size={6}
            data-slot="settings-nav-badge"
            className={cn(narrow && "absolute top-1 right-1")}
          />
        ))}
    </Button>
  );
  if (!narrow) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
