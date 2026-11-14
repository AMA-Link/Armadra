import * as React from "react";
import { useInfiniteQuery } from "@tanstack/react-query";

import { Loadable } from "@/loading/Loadable";
import { Button } from "@/ui/button";
import { Skeleton } from "@/ui/skeleton";
import { Spinner } from "@/ui/spinner";
import { EmptyState } from "@/ui/state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
import { useT } from "@/app/preferences-store";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Field } from "../git/forms";
import {
  type ForgeDetection,
  type ForgeListState,
  type ForgeRepo,
  type ForgeScope,
  forgeIssues,
  forgePulls,
} from "../../api/forge";
import { Failure, IssueDetail, OpenRemote, PullDetail } from "./ForgeDetail";
import { ForgeItemRow } from "./ForgeItemRow";
import { forgeKeys } from "./forge-keys";

export { OpenRemote, forgeKeys };

/**
 * 代码托管面板的仓库视图（契约 §29.4）：GitHub、Gitea、GitLab 同一面，只读——
 * issue 与 PR / MR 的列表（按状态筛、翻页）和详情（标题、状态、标签、作者、
 * 更新时间、正文、在浏览器打开）。写操作（关闭、新建、合并、检出…）core 仍有，
 * 这一面不给。
 */

export type ForgeTab = "issues" | "pulls";

export interface ForgeHostedProps {
  detection: ForgeDetection;
  locale: string;
  /** 打开面板的工作空间：它自己的托管配置优先（契约 §75）。 */
  workspaceId?: ForgeScope;
  /** 关着的面板不发请求。 */
  open: boolean;
  /**
   * 要直接打开的条目（画布上的连接徽标点进来）。`reveal` 每点一次加一，同一条
   * 点两次也会再定位过去。
   */
  focus?: {
    readonly tab: ForgeTab;
    readonly number: number;
    readonly reveal: number;
  } | null;
}

export function ForgeHosted({
  detection,
  locale,
  workspaceId = null,
  open,
  focus = null,
}: ForgeHostedProps) {
  const t = useT();
  const forge = detection.forge ?? "github";
  const repo = detection.repository;
  const [tab, setTab] = React.useState<ForgeTab>(focus?.tab ?? "issues");
  const [state, setState] = React.useState<ForgeListState>("open");
  const [selected, setSelected] = React.useState<number | null>(
    focus?.number ?? null,
  );
  const reveal = focus?.reveal ?? 0;
  const focusTab = focus?.tab;
  const focusNumber = focus?.number;
  React.useEffect(() => {
    if (reveal === 0 || focusTab === undefined || focusNumber === undefined)
      return;
    setTab(focusTab);
    setSelected(focusNumber);
  }, [reveal, focusTab, focusNumber]);

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        setTab(value as ForgeTab);
        setSelected(null);
      }}
      className="min-w-0 gap-0"
      data-slot="forge-hosted"
      data-forge={forge}
    >
      <TabsList
        className="w-full shrink-0 rounded-none border-b border-border"
        variant="line"
      >
        <TabsTrigger value="issues" className="min-w-0 text-meta">
          {t("forge.tab.issues")}
        </TabsTrigger>
        <TabsTrigger value="pulls" className="min-w-0 text-meta">
          {t(`forge.tab.pulls.${forge === "gitlab" ? "gitlab" : "gitea"}`)}
        </TabsTrigger>
      </TabsList>
      {selected === null && (
        <div className="flex min-w-0 items-end gap-2 border-b border-border p-3">
          <Field label={t("forge.filter.state")}>
            <Select
              value={state}
              onValueChange={(next) => setState(next as ForgeListState)}
            >
              <SelectTrigger size="sm" className="w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["open", "closed", "all"] as const).map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`forge.state.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      )}
      <TabsContent
        value="issues"
        className="mt-0 min-w-0 data-[state=inactive]:hidden"
      >
        {selected !== null && tab === "issues" ? (
          <IssueDetail
            repo={repo}
            scope={workspaceId}
            number={selected}
            locale={locale}
            onBack={() => setSelected(null)}
          />
        ) : (
          <IssueList
            repo={repo}
            scope={workspaceId}
            state={state}
            locale={locale}
            enabled={open && tab === "issues"}
            onOpen={setSelected}
          />
        )}
      </TabsContent>
      <TabsContent
        value="pulls"
        className="mt-0 min-w-0 data-[state=inactive]:hidden"
      >
        {selected !== null && tab === "pulls" ? (
          <PullDetail
            repo={repo}
            scope={workspaceId}
            number={selected}
            locale={locale}
            onBack={() => setSelected(null)}
          />
        ) : (
          <PullList
            repo={repo}
            scope={workspaceId}
            state={state}
            locale={locale}
            enabled={open && tab === "pulls"}
            onOpen={setSelected}
          />
        )}
      </TabsContent>
    </Tabs>
  );
}

/* --------------------------------- 列表 --------------------------------- */

function More({
  visible,
  busy,
  onMore,
}: {
  visible: boolean;
  busy: boolean;
  onMore: () => void;
}) {
  const t = useT();
  if (!visible) return null;
  return (
    <Button size="sm" variant="ghost" disabled={busy} onClick={onMore}>
      {busy ? <Spinner data-icon="inline-start" /> : null}
      {t("forge.more")}
    </Button>
  );
}

function IssueList({
  repo,
  scope,
  state,
  locale,
  enabled,
  onOpen,
}: {
  repo: ForgeRepo;
  scope: ForgeScope;
  state: ForgeListState;
  locale: string;
  enabled: boolean;
  onOpen: (number: number) => void;
}) {
  const t = useT();
  const issues = useInfiniteQuery({
    queryKey: forgeKeys.issues(repo, state, scope),
    queryFn: ({ pageParam }) => forgeIssues(repo, state, pageParam, scope),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled,
    retry: false,
  });
  if (issues.isError) return <Failure error={issues.error} />;
  const items = issues.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Loadable
      loading={issues.isLoading}
      skeleton={<ForgeListSkeleton label={t("state.loading")} />}
    >
      <div className="min-w-0 space-y-1.5 p-(--space-page)">
        {issues.data && items.length === 0 && (
          <EmptyState inline title={t("forge.empty")} />
        )}
        {items.map((issue) => (
          <ForgeItemRow
            key={issue.number}
            kind="issue"
            item={issue}
            locale={locale}
            onOpen={() => onOpen(issue.number)}
          />
        ))}
        <More
          visible={issues.hasNextPage}
          busy={issues.isFetchingNextPage}
          onMore={() => void issues.fetchNextPage()}
        />
      </div>
    </Loadable>
  );
}

function PullList({
  repo,
  scope,
  state,
  locale,
  enabled,
  onOpen,
}: {
  repo: ForgeRepo;
  scope: ForgeScope;
  state: ForgeListState;
  locale: string;
  enabled: boolean;
  onOpen: (number: number) => void;
}) {
  const t = useT();
  const pulls = useInfiniteQuery({
    queryKey: forgeKeys.pulls(repo, state, scope),
    queryFn: ({ pageParam }) => forgePulls(repo, state, pageParam, scope),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled,
    retry: false,
  });
  if (pulls.isError) return <Failure error={pulls.error} />;
  const items = pulls.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Loadable
      loading={pulls.isLoading}
      skeleton={<ForgeListSkeleton label={t("state.loading")} />}
    >
      <div className="min-w-0 space-y-1.5 p-(--space-page)">
        {pulls.data && items.length === 0 && (
          <EmptyState inline title={t("forge.empty")} />
        )}
        {items.map((pull) => (
          <ForgeItemRow
            key={pull.number}
            kind="pull"
            item={pull}
            locale={locale}
            onOpen={() => onOpen(pull.number)}
          />
        ))}
        <More
          visible={pulls.hasNextPage}
          busy={pulls.isFetchingNextPage}
          onMore={() => void pulls.fetchNextPage()}
        />
      </div>
    </Loadable>
  );
}

/** 与 `Row` 同样的边框、圆角与内边距：编号条、标题条、徽标，下面一行元信息。 */
export function ForgeListSkeleton({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      data-slot="forge-list-skeleton"
      className="min-w-0 space-y-1.5 p-(--space-page)"
    >
      {[0, 1, 2, 3, 4].map((index) => (
        <div
          key={index}
          className="flex min-h-14 min-w-0 flex-col gap-1 rounded-card border border-border px-3 py-2"
        >
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-8 shrink-0" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="ml-auto h-5 w-12 shrink-0 rounded-full" />
          </div>
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}
