import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { IconButton } from "@/ui/icon-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { useSettingsPage } from "./page-context";
import { settingsSection } from "./nav";
import { subpageTitleKey, useSubpage } from "./subpage";

/**
 * 设置页的页头（设计系统 §5.17）：`h2 text-display` 页名 + 右侧动作槽，**没有副标题**。
 *
 * 页名由外壳给的分区 id 推出；停在子页时换成子页名，左侧多一个「←」（Tooltip 带 Esc）。
 * 页面自己只传 `actions`：至多一个 `default sm` 主动作 + 若干 `outline sm`。
 * 每一页都在最上面渲染一个，分区页与子页都是。
 */
export function SettingsPageHeader({
  actions,
  title,
}: {
  actions?: ReactNode;
  /** 覆盖页名；缺省按分区 / 子页取。 */
  title?: string;
}) {
  const t = useT();
  const { sectionId } = useSettingsPage();
  const subpage = useSubpage();
  const heading =
    title ??
    (subpage.current
      ? t(subpageTitleKey(subpage.current))
      : sectionId
        ? t(settingsSection(sectionId).labelKey)
        : t("settings.title"));
  return (
    <header
      data-slot="settings-page-header"
      className="flex items-center gap-2 py-0.5"
    >
      {subpage.current && (
        <Tooltip>
          <TooltipTrigger asChild>
            <IconButton
              size="cluster"
              label={t("settings.back")}
              onClick={subpage.close}
            >
              <ChevronLeft />
            </IconButton>
          </TooltipTrigger>
          <TooltipContent shortcut="Esc">{t("settings.back")}</TooltipContent>
        </Tooltip>
      )}
      <h2
        data-testid="settings-heading"
        className="min-w-0 flex-1 truncate text-display font-semibold text-strong"
      >
        {heading}
      </h2>
      {actions && (
        <div
          data-slot="settings-page-actions"
          className="flex shrink-0 flex-wrap items-center justify-end gap-2"
        >
          {actions}
        </div>
      )}
    </header>
  );
}
