import * as React from "react";
import { X } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { IconButton } from "@/ui/icon-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import type { SettingsSection } from "./nav";
import { ScopeBadge } from "./scope-badge";
import { subpageTitleKey } from "./subpage";

/**
 * 设置顶栏（设计系统 §5.17）：左面包屑「设置 › 分组 › 页名（› 子页）」，末级 `text-body`
 * 500 `--text`，其余 `--muted-foreground`，分隔符 `›` 用 `--faint`；右侧搜索、作用范围
 * 徽标、关闭。面包屑是 `nav` + `ol`，末级 `aria-current="page"`。
 */
export function SettingsTopbar({
  section,
  subpage,
  search,
  onClose,
}: {
  section: SettingsSection;
  subpage: string | null;
  search: React.ReactNode;
  onClose: () => void;
}) {
  const t = useT();
  const crumbs = [
    t("settings.breadcrumb.root"),
    t(section.groupKey),
    t(section.labelKey),
    ...(subpage ? [t(subpageTitleKey(subpage))] : []),
  ];
  return (
    <div
      data-slot="settings-topbar"
      className="flex h-(--settings-topbar-h) shrink-0 items-center gap-3 pr-4"
    >
      <nav aria-label={t("settings.breadcrumb")} className="min-w-0 flex-1">
        <ol className="flex min-w-0 items-center gap-1.5 text-body text-muted-foreground">
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1;
            return (
              <li
                key={`${index}:${crumb}`}
                className="flex min-w-0 items-center gap-1.5"
                {...(last ? { "aria-current": "page" as const } : {})}
              >
                {index > 0 && (
                  <span aria-hidden className="text-faint">
                    ›
                  </span>
                )}
                <span
                  className={
                    last ? "truncate font-medium text-foreground" : "truncate"
                  }
                >
                  {crumb}
                </span>
              </li>
            );
          })}
        </ol>
      </nav>
      <div className="w-64 shrink-0">{search}</div>
      <ScopeBadge
        scope={section.scope}
        pinnedLocal={section.pinnedLocal}
        followsWorkspace={section.followsWorkspace}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <IconButton size="cluster" label={t("tab.close")} onClick={onClose}>
            <X />
          </IconButton>
        </TooltipTrigger>
        <TooltipContent shortcut="Esc">{t("tab.close")}</TooltipContent>
      </Tooltip>
    </div>
  );
}
