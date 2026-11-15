import * as React from "react";
import { ChevronDown, Search } from "lucide-react";
import { FORGE_QUERY_MAX } from "@armadra/shared";

import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { Input } from "@/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { useT } from "@/app/preferences-store";
import type { ForgeListState } from "../../api/forge";
import {
  REVIEW_CHOICES,
  SORT_CHOICES,
  type ForgeQualifier,
  type ForgeSortId,
  qualifierValues,
  setQualifier,
  toggleQualifier,
} from "./forge-query";
import type { ForgeTab } from "./ForgeHosted";

/** 筛选下拉的候选：有 facets 用 facets，没有时调用方给列表里出现过的值。 */
export interface ForgeFilterOptions {
  authors: readonly string[];
  labels: readonly string[];
  milestones: readonly string[];
  assignees: readonly string[];
}

/** 一个筛选下拉：选中时按钮写成「名称 · 值」并高亮；候选为空且没选时停用。 */
function FilterChip({
  label,
  values,
  options,
  multiple = false,
  onToggle,
  onSelect,
  render,
}: {
  label: string;
  values: readonly string[];
  options: readonly string[];
  multiple?: boolean;
  onToggle?: (value: string) => void;
  onSelect?: (value: string) => void;
  render?: (value: string) => string;
}) {
  const t = useT();
  const shown = render ?? ((value: string) => value);
  const active = values.length > 0;
  const all = [...new Set([...values, ...options])];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant={active ? "secondary" : "outline"}
          disabled={!active && all.length === 0}
          data-slot="forge-filter"
          data-active={active}
          className="min-w-0 max-w-32"
        >
          <span className="truncate">
            {active ? `${label} · ${values.map(shown).join(", ")}` : label}
          </span>
          <ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
        {multiple ? (
          all.map((value) => (
            <DropdownMenuCheckboxItem
              key={value}
              checked={values.includes(value)}
              onSelect={(event) => {
                event.preventDefault();
                onToggle?.(value);
              }}
            >
              {shown(value)}
            </DropdownMenuCheckboxItem>
          ))
        ) : (
          <DropdownMenuRadioGroup
            value={values[0] ?? ""}
            onValueChange={(value) => onSelect?.(value)}
          >
            <DropdownMenuRadioItem value="">
              {t("forge.filter.any")}
            </DropdownMenuRadioItem>
            {all.map((value) => (
              <DropdownMenuRadioItem key={value} value={value}>
                {shown(value)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 列表顶部：搜索框（限定词串）、筛选下拉（作者、标签、里程碑、审查、指派、
 * 排序）、开启 / 已关闭计数。下拉写回限定词串，搜索框里改了限定词下拉跟着变；
 * 回车立即查，停手 400ms 后查，内容没变不发请求。
 */
export function ForgeSearchBar({
  kind,
  query,
  onQuery,
  state,
  onState,
  counts,
  sort,
  onSort,
  options,
  unsupported,
}: {
  kind: ForgeTab;
  query: string;
  onQuery: (query: string) => void;
  state: ForgeListState;
  onState: (state: ForgeListState) => void;
  counts: { open: number | null; closed: number | null };
  sort: ForgeSortId;
  onSort: (sort: ForgeSortId) => void;
  options: ForgeFilterOptions;
  unsupported: readonly string[];
}) {
  const t = useT();
  const [text, setText] = React.useState(query);
  React.useEffect(() => setText(query), [query]);
  const commit = React.useCallback(
    (value: string) => {
      const next = value.trim();
      if (next !== query.trim()) onQuery(next);
    },
    [onQuery, query],
  );
  React.useEffect(() => {
    const timer = setTimeout(() => commit(text), 400);
    return () => clearTimeout(timer);
  }, [text, commit]);

  const values = (key: ForgeQualifier) => qualifierValues(query, key);
  const single = (key: ForgeQualifier) => (value: string) =>
    onQuery(setQualifier(query, key, value ? [value] : []));
  const number = (value: number | null) => (value === null ? "" : ` ${value}`);

  return (
    <div
      className="flex min-w-0 flex-col gap-2 border-b border-border p-3"
      data-slot="forge-search"
    >
      <div className="relative min-w-0">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          size="sm"
          type="search"
          value={text}
          maxLength={FORGE_QUERY_MAX}
          aria-label={t("forge.search")}
          placeholder={t("forge.search.placeholder")}
          className="pl-8"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit(text);
          }}
        />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <FilterChip
          label={t("forge.filter.author")}
          values={values("author")}
          options={options.authors}
          onSelect={single("author")}
        />
        <FilterChip
          label={t("forge.filter.label")}
          values={values("label")}
          options={options.labels}
          multiple
          onToggle={(value) => onQuery(toggleQualifier(query, "label", value))}
        />
        <FilterChip
          label={t("forge.filter.milestone")}
          values={values("milestone")}
          options={options.milestones}
          onSelect={single("milestone")}
        />
        {kind === "pulls" && (
          <FilterChip
            label={t("forge.filter.review")}
            values={values("review")}
            options={REVIEW_CHOICES}
            render={(value) => t(`forge.filter.review.${value}`)}
            onSelect={single("review")}
          />
        )}
        <FilterChip
          label={t("forge.filter.assignee")}
          values={values("assignee")}
          options={options.assignees}
          onSelect={single("assignee")}
        />
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <ToggleGroup
          type="single"
          size="sm"
          value={state === "all" ? "" : state}
          onValueChange={(value) => {
            // 切状态时去掉搜索串里的 is:，不然它优先、按钮像是失灵。
            if (qualifierValues(query, "is").length > 0)
              onQuery(setQualifier(query, "is", []));
            onState((value || "all") as ForgeListState);
          }}
          aria-label={t("forge.filter.state")}
        >
          <ToggleGroupItem value="open" className="text-meta">
            {t("forge.state.open")}
            {number(counts.open)}
          </ToggleGroupItem>
          <ToggleGroupItem value="closed" className="text-meta">
            {t("forge.state.closed")}
            {number(counts.closed)}
          </ToggleGroupItem>
        </ToggleGroup>
        <div className="flex-1" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              data-slot="forge-sort"
              className="min-w-0"
            >
              <span className="truncate">{t(`forge.sort.${sort}`)}</span>
              <ChevronDown data-icon="inline-end" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup
              value={sort}
              onValueChange={(value) => onSort(value as ForgeSortId)}
            >
              {SORT_CHOICES.map((choice) => (
                <DropdownMenuRadioItem key={choice.id} value={choice.id}>
                  {t(`forge.sort.${choice.id}`)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {unsupported.length > 0 && (
        <p
          role="status"
          data-slot="forge-unsupported"
          className="text-meta text-warn-text"
        >
          {t("forge.unsupported", { terms: unsupported.join(", ") })}
        </p>
      )}
    </div>
  );
}
