import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { SearchIcon } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { Command, CommandEmpty, CommandItem, CommandList } from "@/ui/command";
import { InputGroup, InputGroupAddon } from "@/ui/input-group";
import { Kbd } from "@/ui/kbd";
import { settingsSection } from "./nav";
import { searchSettings, type SettingsSearchHit } from "./search-index";

/**
 * 顶栏的设置搜索（设计系统 §5.17）：纯客户端，匹配页名与各页登记的行标签
 * （`search-index.ts`）。输入框在顶栏里，结果以 `Command` 列表出现在它下方（↑↓ 选择、
 * 回车跳转，列表没有开关动画）；点别处或 Esc 收起。
 *
 * 文字由外壳持有：快捷键页也读它来过滤表格。
 */
export function SettingsSearch({
  query,
  onQueryChange,
  sectionIds,
  onPick,
  inputRef,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  sectionIds: readonly string[];
  onPick: (hit: SettingsSearchHit) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const t = useT();
  const [focused, setFocused] = React.useState(false);
  const hits = React.useMemo(
    () =>
      searchSettings(
        query,
        sectionIds,
        (key) => t(key),
        (id) => settingsSection(id).labelKey,
      ),
    [query, sectionIds, t],
  );
  const open = focused && query.trim() !== "";

  return (
    <Command
      shouldFilter={false}
      loop
      label={t("settings.search")}
      className="relative size-auto w-full overflow-visible bg-transparent p-0"
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setFocused(false);
      }}
    >
      <InputGroup size="sm" className="bg-card">
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        <CommandPrimitive.Input
          ref={inputRef}
          data-slot="settings-search"
          value={query}
          onValueChange={onQueryChange}
          placeholder={t("settings.search")}
          aria-label={t("settings.search")}
          className="h-full min-w-0 flex-1 bg-transparent px-1 text-body outline-hidden placeholder:text-muted-foreground"
        />
        <InputGroupAddon align="inline-end">
          <Kbd>⌘F</Kbd>
        </InputGroupAddon>
      </InputGroup>
      {open && (
        <div
          data-slot="settings-search-results"
          // 保持输入框的焦点：鼠标按下结果行时不让它先失焦、把列表收掉
          onMouseDown={(event) => event.preventDefault()}
          className="absolute top-full right-0 z-(--z-menu) mt-1 w-[min(360px,calc(100vw-48px))] rounded-card border border-border bg-popover shadow-overlay"
        >
          <CommandList
            aria-label={t("settings.search.results")}
            className="p-1"
          >
            <CommandEmpty>{t("settings.search.empty")}</CommandEmpty>
            {hits.map((hit) => {
              const section = t(settingsSection(hit.sectionId).labelKey);
              return (
                <CommandItem
                  key={`${hit.sectionId}:${hit.rowKey ?? ""}`}
                  value={`${hit.sectionId}:${hit.rowKey ?? ""}`}
                  aria-label={
                    hit.rowKey ? `${section} › ${t(hit.rowKey)}` : section
                  }
                  onSelect={() => onPick(hit)}
                >
                  <span className="truncate text-muted-foreground">
                    {section}
                  </span>
                  {hit.rowKey && (
                    <>
                      <span aria-hidden className="text-faint">
                        ›
                      </span>
                      <span className="truncate">{t(hit.rowKey)}</span>
                    </>
                  )}
                </CommandItem>
              );
            })}
          </CommandList>
        </div>
      )}
    </Command>
  );
}
