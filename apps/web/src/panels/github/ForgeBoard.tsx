import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/ui/badge";
import { EmptyState } from "@/ui/state";
import { useT } from "@/app/preferences-store";
import type {
  ForgeListState,
  ForgeRepo,
  ForgeScope,
  ForgeSort,
} from "../../api/forge";
import { Failure } from "./ForgeDetail";
import { ForgeItemRow } from "./ForgeItemRow";
import { ForgeListSkeleton } from "./ForgeListSkeleton";
import { type ForgePage, type ForgeRowWrap, listRequest } from "./ForgeList";
import { forgeKeys, type ForgeListKey } from "./forge-keys";
import { stateFromQuery } from "./forge-query";
import type { ForgeTab } from "./ForgeHosted";

type Item = ForgePage["items"][number];

/** 一条 PR 在「审查中」列：有审查请求或被要求修改。 */
function inReview(item: Item): boolean {
  return (
    "reviewDecision" in item &&
    (item.reviewDecision === "changesRequested" ||
      item.reviewDecision === "reviewRequired")
  );
}

interface Column {
  id: "open" | "review" | "merged" | "closed";
  items: readonly Item[];
}

function useBoardColumn({
  kind,
  repo,
  scope,
  state,
  list,
  enabled,
}: {
  kind: ForgeTab;
  repo: ForgeRepo;
  scope: ForgeScope;
  state: ForgeListState;
  list: ForgeListKey;
  enabled: boolean;
}) {
  return useQuery({
    queryKey:
      kind === "issues"
        ? forgeKeys.issues(repo, state, scope, list)
        : forgeKeys.pulls(repo, state, scope, list),
    queryFn: () => listRequest(kind, repo, scope, state, list),
    enabled,
    retry: false,
  });
}

/**
 * 看板：Issue 分「开启 / 已关闭」，PR 分「开启 / 审查中 / 已合并」。每列各取
 * 第一页（沿用搜索串与排序），行是列表里同一个组件。
 */
export function ForgeBoard({
  kind,
  repo,
  scope,
  locale,
  enabled,
  query,
  sort,
  direction,
  onOpen,
  wrapRow,
}: {
  kind: ForgeTab;
  repo: ForgeRepo;
  scope: ForgeScope;
  locale: string;
  enabled: boolean;
  query: string;
  sort: ForgeSort;
  direction: "asc" | "desc";
  onOpen: (number: number) => void;
  wrapRow?: ForgeRowWrap;
}) {
  const t = useT();
  const pinned = stateFromQuery(query);
  const column = (state: ForgeListState) => ({
    kind,
    repo,
    scope,
    state,
    list: { q: query, sort, direction, page: 1, cursor: null },
    enabled: enabled && (pinned === null || pinned === state),
  });
  const open = useBoardColumn(column("open"));
  const closed = useBoardColumn(column("closed"));
  const error = open.error ?? closed.error;
  if (error) return <Failure error={error} />;
  if (open.isLoading || closed.isLoading)
    return <ForgeListSkeleton label={t("state.loading")} />;

  const openItems = open.data?.items ?? [];
  const closedItems = closed.data?.items ?? [];
  const columns: Column[] =
    kind === "issues"
      ? [
          { id: "open", items: openItems },
          { id: "closed", items: closedItems },
        ]
      : [
          { id: "open", items: openItems.filter((item) => !inReview(item)) },
          { id: "review", items: openItems.filter(inReview) },
          {
            id: "merged",
            items: closedItems.filter((item) => item.state === "merged"),
          },
        ];
  const rowKind = kind === "issues" ? "issue" : "pull";
  return (
    <div
      data-slot="forge-board"
      className="flex min-w-0 gap-2 overflow-x-auto p-(--space-page)"
    >
      {columns.map((entry) => (
        <section
          key={entry.id}
          data-slot="forge-board-column"
          data-column={entry.id}
          className="flex w-64 shrink-0 flex-col gap-1.5"
        >
          <h4 className="flex items-center gap-1.5 text-meta font-medium">
            {t(`forge.board.${entry.id}`)}
            <Badge variant="secondary" size="sm">
              {entry.items.length}
            </Badge>
          </h4>
          {entry.items.length === 0 && (
            <EmptyState inline title={t("forge.empty")} />
          )}
          {entry.items.map((item) => {
            const element = (
              <ForgeItemRow
                key={item.number}
                kind={rowKind}
                item={item}
                locale={locale}
                columns={false}
                onOpen={() => onOpen(item.number)}
              />
            );
            return wrapRow ? wrapRow(rowKind, item.number, element) : element;
          })}
        </section>
      ))}
    </div>
  );
}
