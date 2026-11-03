import { useMemo } from "react";

import { RUNTIME_VIA_SERVER_SHELL } from "@/api/request";
import { useAccess } from "@/app/use-access";
import { useT } from "@/app/preferences-store";
import { useRemoteAccess } from "@/panels/settings/remote-access";
import {
  visibleSettingsSections,
  settingsSection,
} from "@/panels/settings/nav";
import { SETTINGS_SEARCH } from "@/panels/settings/search-index";
import { parseQuery, prepare, scoreFields, type Prepared } from "./match";

export interface SettingsEntry {
  sectionId: string;
  /** 行标签的 i18n 键；整页命中时为 `null`。 */
  rowKey: string | null;
  /** 显示的标题：页名，或行名。 */
  title: string;
  /** 右侧的次要文字：行所在的页名；整页没有。 */
  page: string;
  primary: Prepared;
  secondary: readonly Prepared[];
}

/** 设置一组最多列这么多条。 */
export const SETTINGS_LIMIT = 6;

/** 可见设置页的页名与各页登记的行标签（已翻译），跟着成员 / 远程身份变化。 */
export function useSettingsEntries(enabled: boolean): SettingsEntry[] {
  const t = useT();
  const { member } = useAccess();
  const { remote } = useRemoteAccess();
  return useMemo(() => {
    if (!enabled) return [];
    const out: SettingsEntry[] = [];
    for (const section of visibleSettingsSections(
      RUNTIME_VIA_SERVER_SHELL,
      member,
      remote,
    )) {
      const page = t(settingsSection(section.id).labelKey);
      out.push({
        sectionId: section.id,
        rowKey: null,
        title: page,
        page: "",
        primary: prepare(page),
        secondary: [],
      });
      for (const rowKey of SETTINGS_SEARCH[section.id] ?? []) {
        const title = t(rowKey);
        out.push({
          sectionId: section.id,
          rowKey,
          title,
          page,
          primary: prepare(title),
          secondary: [prepare(page)],
        });
      }
    }
    return out;
  }, [enabled, member, remote, t]);
}

/** 设置项 → 命中（得分降序，空查询不列）。 */
export function searchSettingsEntries(
  entries: readonly SettingsEntry[],
  query: string,
  limit: number = SETTINGS_LIMIT,
): SettingsEntry[] {
  const terms = parseQuery(query);
  if (terms.length === 0) return [];
  return entries
    .map((entry) => ({
      entry,
      score: scoreFields(terms, entry.primary, entry.secondary).score,
    }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((hit) => hit.entry);
}
