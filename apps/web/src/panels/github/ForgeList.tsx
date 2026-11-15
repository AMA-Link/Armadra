import * as React from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { Loadable } from "@/loading/Loadable";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
  paginationRange,
} from "@/ui/pagination";
import { EmptyState } from "@/ui/state";
import { useT } from "@/app/preferences-store";
import {
  type ForgeIssuePage,
  type ForgeListState,
  type ForgePullPage,
  type ForgeRepo,
  type ForgeScope,
  forgeFacets,
  forgeIssues,
  forgePulls,
} from "../../api/forge";
import { Failure } from "./ForgeDetail";
import { ForgeBoard } from "./ForgeBoard";
import { ForgeItemMenu } from "./ForgeItemMenu";
import { ForgeItemRow } from "./ForgeItemRow";
import { ForgeListSkeleton } from "./ForgeListSkeleton";
import { ForgeSearchBar, type ForgeFilterOptions } from "./ForgeSearchBar";
import { forgeKeys, type ForgeListKey } from "./forge-keys";
import { SORT_CHOICES, type ForgeSortId, stateFromQuery } from "./forge-query";
import type { ForgeTab } from "./ForgeHosted";

export type ForgeView = "list" | "board";
export type ForgePage = ForgeIssuePage | ForgePullPage;

const sortChoice = (id: ForgeSortId) =>
  SORT_CHOICES.find((choice) => choice.id === id) ?? SORT_CHOICES[0];

/** 列表请求：按页码翻（新 core）与按 cursor 翻（旧 core）同时带上，各取所需。 */
export function listRequest(
  kind: ForgeTab,
  repo: ForgeRepo,
  scope: ForgeScope,
  state: ForgeListState,
  list: ForgeListKey,
): Promise<ForgePage> {
  const options = {
    q: list.q,
    sort: list.sort,
    direction: list.direction,
    page: list.page,
  };
  return kind === "issues"
    ? forgeIssues(repo, state, list.cursor, scope, options)
    : forgePulls(repo, state, list.cursor, scope, options);
}

function distinct(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => !!value))];
}

/**
 * 一个标签页的列表：搜索与筛选、计数、行、页码。面板与画布节点是同一份；
 * 搜索串由调用方持有（画布节点把它存进自己的数据）。
 */
export function ForgeList({
  kind,
  repo,
  scope,
  locale,
  enabled,
  query,
  onQuery,
  view = "list",
  onOpen,
  onCounts,
}: {
  kind: ForgeTab;
  repo: ForgeRepo;
  scope: ForgeScope;
  locale: string;
  enabled: boolean;
  query: string;
  onQuery: (query: string) => void;
  view?: ForgeView;
  onOpen: (number: number) => void;
  onCounts?: (count: number | null) => void;
}) {
  const t = useT();
  const [state, setState] = React.useState<ForgeListState>("open");
  const [sortId, setSortId] = React.useState<ForgeSortId>("updated-desc");
  const [page, setPage] = React.useState(1);
  const [cursors, setCursors] = React.useState<Record<number, string>>({});
  const effective = stateFromQuery(query) ?? state;
  const { sort, direction } = sortChoice(sortId);
  const list: ForgeListKey = {
    q: query,
    sort,
    direction,
    page,
    cursor: cursors[page] ?? null,
  };
  const rowKind = kind === "issues" ? "issue" : "pull";

  const reset = () => {
    setPage(1);
    setCursors({});
  };

  const result = useQuery({
    queryKey:
      kind === "issues"
        ? forgeKeys.issues(repo, effective, scope, list)
        : forgeKeys.pulls(repo, effective, scope, list),
    queryFn: () => listRequest(kind, repo, scope, effective, list),
    enabled: enabled && view === "list",
    placeholderData: keepPreviousData,
    retry: false,
  });
  const facets = useQuery({
    queryKey: forgeKeys.facets(repo, scope),
    queryFn: () => forgeFacets(repo, scope),
    enabled,
    retry: false,
    staleTime: 60_000,
  });

  const data = result.data;
  const items: readonly ForgePage["items"][number][] = data?.items ?? [];
  const openCount = data?.openCount ?? null;
  const closedCount = data?.closedCount ?? null;
  const onCountsRef = React.useRef(onCounts);
  onCountsRef.current = onCounts;
  // 标签页上的数字：没有搜索时开启加已关闭；旧 core 不给计数就不画。
  const total =
    query.trim() === "" && openCount !== null && closedCount !== null
      ? openCount + closedCount
      : null;
  React.useEffect(() => {
    if (query.trim() === "") onCountsRef.current?.(total);
  }, [total, query]);

  const options: ForgeFilterOptions = React.useMemo(
    () => ({
      authors: distinct(items.map((item) => item.author)),
      labels: distinct([
        ...(facets.data?.labels.map((label) => label.name) ?? []),
        ...items.flatMap((item) => item.labels ?? []),
      ]),
      milestones: distinct([
        ...(facets.data?.milestones.map((entry) => entry.title) ?? []),
        ...items.map((item) => ("milestone" in item ? item.milestone : null)),
      ]),
      assignees: distinct([
        ...(facets.data?.assignees ?? []),
        ...items.flatMap((item) => ("assignees" in item ? item.assignees : [])),
      ]),
    }),
    [items, facets.data],
  );

  const row = (item: ForgePage["items"][number]) => (
    <ForgeItemMenu
      key={item.number}
      repo={repo}
      kind={rowKind}
      number={item.number}
      url={item.url}
      onOpen={() => onOpen(item.number)}
    >
      <ForgeItemRow
        kind={rowKind}
        item={item}
        locale={locale}
        onOpen={() => onOpen(item.number)}
      />
    </ForgeItemMenu>
  );

  const shownPage = data?.page ?? page;
  const pageCount = data?.pageCount ?? null;
  const goTo = (next: number) => setPage(Math.max(1, next));
  const nextCursor = data?.nextCursor ?? null;

  return (
    <div className="min-w-0" data-slot="forge-list" data-view={view}>
      <ForgeSearchBar
        kind={kind}
        query={query}
        onQuery={(next) => {
          reset();
          onQuery(next);
        }}
        state={effective}
        onState={(next) => {
          reset();
          setState(next);
        }}
        counts={{ open: openCount, closed: closedCount }}
        sort={sortId}
        onSort={(next) => {
          reset();
          setSortId(next);
        }}
        options={options}
        unsupported={data?.unsupported ?? []}
      />
      {view === "board" ? (
        <ForgeBoard
          kind={kind}
          repo={repo}
          scope={scope}
          locale={locale}
          enabled={enabled}
          query={query}
          sort={sort}
          direction={direction}
          onOpen={onOpen}
        />
      ) : result.isError ? (
        <Failure error={result.error} />
      ) : (
        <Loadable
          loading={result.isLoading}
          skeleton={<ForgeListSkeleton label={t("state.loading")} />}
        >
          <div className="min-w-0 space-y-1.5 p-(--space-page)">
            {data && items.length === 0 && (
              <EmptyState inline title={t("forge.empty")} />
            )}
            {items.map(row)}
            {pageCount !== null && pageCount > 1 ? (
              <Pagination aria-label={t("forge.page")} className="pt-1">
                <PaginationContent>
                  <PaginationItem>
                    <PaginationPrevious
                      text={t("forge.page.prev")}
                      disabled={shownPage <= 1}
                      onClick={() => goTo(shownPage - 1)}
                    />
                  </PaginationItem>
                  {paginationRange(shownPage - 1, pageCount).map(
                    (entry, index) =>
                      entry === "gap" ? (
                        <PaginationItem key={`gap-${index}`}>
                          <PaginationEllipsis />
                        </PaginationItem>
                      ) : (
                        <PaginationItem key={entry}>
                          <PaginationLink
                            isActive={entry + 1 === shownPage}
                            onClick={() => goTo(entry + 1)}
                          >
                            {entry + 1}
                          </PaginationLink>
                        </PaginationItem>
                      ),
                  )}
                  <PaginationItem>
                    <PaginationNext
                      text={t("forge.page.next")}
                      disabled={shownPage >= pageCount}
                      onClick={() => goTo(shownPage + 1)}
                    />
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
            ) : pageCount === null && (page > 1 || nextCursor) ? (
              <Pagination aria-label={t("forge.page")} className="pt-1">
                <PaginationContent>
                  <PaginationItem>
                    <PaginationPrevious
                      text={t("forge.page.prev")}
                      disabled={page <= 1}
                      onClick={() => goTo(page - 1)}
                    />
                  </PaginationItem>
                  <PaginationItem>
                    <PaginationNext
                      text={t("forge.page.next")}
                      disabled={!nextCursor}
                      onClick={() => {
                        if (!nextCursor) return;
                        setCursors((current) => ({
                          ...current,
                          [page + 1]: nextCursor,
                        }));
                        goTo(page + 1);
                      }}
                    />
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
            ) : null}
          </div>
        </Loadable>
      )}
    </div>
  );
}
