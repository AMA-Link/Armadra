import * as React from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink } from "lucide-react";

import { Loadable } from "@/loading/Loadable";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { Skeleton } from "@/ui/skeleton";
import { Spinner } from "@/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
import { useT } from "@/app/preferences-store";
import { openExternal } from "@/platform";
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
  type ForgeIssue,
  type ForgeListState,
  type ForgePull,
  type ForgeRepo,
  type ForgeScope,
  forgeFailureKey,
  forgeIssue,
  forgeIssues,
  forgePull,
  forgePulls,
} from "../../api/forge";

/**
 * 代码托管面板的仓库视图（契约 §29.4）：GitHub、Gitea、GitLab 同一面，只读——
 * issue 与 PR / MR 的列表（按状态筛、翻页）和详情（标题、状态、标签、作者、
 * 更新时间、正文、在浏览器打开）。写操作（关闭、新建、合并、检出…）core 仍有，
 * 这一面不给。
 */

export type ForgeTab = "issues" | "pulls";

/** 仓库加范围：两个工作空间对同一仓库可能用不同的配置（契约 §75）。 */
function repoKey(repo: ForgeRepo, scope: ForgeScope): string {
  return `${scope ?? ""}|${repo.host}/${repo.owner}/${repo.name}`;
}

export const forgeKeys = {
  all: ["forge"] as const,
  issues: (repo: ForgeRepo, state: ForgeListState, scope: ForgeScope = null) =>
    ["forge", "issues", repoKey(repo, scope), state] as const,
  issue: (repo: ForgeRepo, number: number, scope: ForgeScope = null) =>
    ["forge", "issue", repoKey(repo, scope), number] as const,
  pulls: (repo: ForgeRepo, state: ForgeListState, scope: ForgeScope = null) =>
    ["forge", "pulls", repoKey(repo, scope), state] as const,
  pull: (repo: ForgeRepo, number: number, scope: ForgeScope = null) =>
    ["forge", "pull", repoKey(repo, scope), number] as const,
};

function when(ms: number | null, locale: string): string {
  if (!ms || ms <= 0) return "";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ms));
}

export function OpenRemote({ url }: { url: string }) {
  const t = useT();
  if (!url) return null;
  return (
    <IconButton
      label={t("forge.openRemote")}
      onClick={() => void openExternal(url)}
    >
      <ExternalLink />
    </IconButton>
  );
}

function Failure({ error }: { error: unknown }) {
  const t = useT();
  return (
    <p
      role="status"
      data-slot="forge-failure"
      className="px-3 py-2 text-[12px] text-destructive"
    >
      {t(forgeFailureKey(error))}
    </p>
  );
}

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
        className="h-10 w-full shrink-0 rounded-none border-b border-border"
        variant="line"
      >
        <TabsTrigger value="issues" className="min-w-0 text-xs">
          {t("forge.tab.issues")}
        </TabsTrigger>
        <TabsTrigger value="pulls" className="min-w-0 text-xs">
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
              <SelectTrigger className="h-9 w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[var(--z-dialog)]">
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
    <Button
      size="sm"
      variant="ghost"
      className="min-h-10"
      disabled={busy}
      onClick={onMore}
    >
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
          <p className="text-[12px] text-muted-foreground">
            {t("forge.empty")}
          </p>
        )}
        {items.map((issue) => (
          <Row
            key={issue.number}
            slot="forge-issue"
            number={issue.number}
            title={issue.title}
            badges={[t(`forge.state.${issue.state}`)]}
            meta={[issue.author, when(issue.updatedAtMs, locale)]}
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
          <p className="text-[12px] text-muted-foreground">
            {t("forge.empty")}
          </p>
        )}
        {items.map((pull) => (
          <Row
            key={pull.number}
            slot="forge-pull"
            number={pull.number}
            title={pull.title}
            badges={[
              t(`forge.state.${pull.state}`),
              ...(pull.draft ? [t("forge.draft")] : []),
            ]}
            meta={[
              `${pull.headRef} → ${pull.baseRef}`,
              when(pull.updatedAtMs, locale),
            ]}
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
          className="flex min-h-10 min-w-0 flex-col gap-1 rounded-lg border border-border px-3 py-2"
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

/** 详情页：标题条、徽标行、元信息、四行正文。 */
function ForgeDetailSkeleton({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      className="flex min-w-0 flex-col gap-(--space-block)"
    >
      <Skeleton className="h-5 w-3/4" />
      <Skeleton className="h-5 w-24 rounded-full" />
      <Skeleton className="h-3 w-1/2" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
}

function Row({
  slot,
  number,
  title,
  badges,
  meta,
  onOpen,
}: {
  slot: string;
  number: number;
  title: string;
  badges: string[];
  meta: (string | null)[];
  onOpen: () => void;
}) {
  return (
    <article
      data-slot={slot}
      data-number={number}
      className="min-w-0 rounded-lg border border-border"
    >
      <Button
        variant="ghost"
        className="h-auto min-h-10 w-full min-w-0 flex-col items-stretch gap-1 px-3 py-2 text-left"
        onClick={onOpen}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 tabular-nums text-muted-foreground">
            #{number}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
            {title}
          </span>
          {badges.map((badge) => (
            <Badge key={badge} variant="secondary">
              {badge}
            </Badge>
          ))}
        </span>
        <span className="min-w-0 truncate text-[12px] font-normal text-muted-foreground">
          {meta.filter(Boolean).join(" · ")}
        </span>
      </Button>
    </article>
  );
}

/* --------------------------------- 详情 --------------------------------- */

function Back({ onBack, url }: { onBack: () => void; url: string }) {
  const t = useT();
  return (
    <div className="flex min-w-0 items-center gap-1">
      <IconButton label={t("forge.back")} onClick={onBack}>
        <ArrowLeft />
      </IconButton>
      <div className="flex-1" />
      <OpenRemote url={url} />
    </div>
  );
}

function Heading({ number, title }: { number: number; title: string }) {
  return (
    <h3 className="min-w-0 text-[14px] font-semibold break-words">
      <span className="mr-2 tabular-nums text-muted-foreground">#{number}</span>
      {title}
    </h3>
  );
}

function Body({ text }: { text: string }) {
  if (!text) return null;
  return (
    <p className="min-w-0 text-[13px] leading-5 break-words whitespace-pre-wrap select-text">
      {text}
    </p>
  );
}

function ForgeDetailLoading() {
  const t = useT();
  return (
    <Loadable
      loading
      skeleton={<ForgeDetailSkeleton label={t("state.loading")} />}
    >
      {null}
    </Loadable>
  );
}

function IssueDetail({
  repo,
  scope,
  number,
  locale,
  onBack,
}: {
  repo: ForgeRepo;
  scope: ForgeScope;
  number: number;
  locale: string;
  onBack: () => void;
}) {
  const issue = useQuery({
    queryKey: forgeKeys.issue(repo, number, scope),
    queryFn: () => forgeIssue(repo, number, scope),
    retry: false,
  });
  return (
    <div
      className="flex min-w-0 flex-col gap-(--space-block) p-(--space-page)"
      data-slot="forge-issue-detail"
    >
      <Back onBack={onBack} url={issue.data?.url ?? ""} />
      {issue.isError && <Failure error={issue.error} />}
      {issue.isLoading && <ForgeDetailLoading />}
      {issue.data && <IssueBody issue={issue.data} locale={locale} />}
    </div>
  );
}

function IssueBody({ issue, locale }: { issue: ForgeIssue; locale: string }) {
  const t = useT();
  return (
    <>
      <div className="flex min-w-0 flex-col gap-(--space-group)">
        <Heading number={issue.number} title={issue.title} />
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge variant="secondary">{t(`forge.state.${issue.state}`)}</Badge>
          {issue.labels.map((label) => (
            <Badge key={label} variant="outline">
              {label}
            </Badge>
          ))}
        </div>
        <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
          <dt className="text-muted-foreground">{t("forge.author")}</dt>
          <dd className="min-w-0 truncate">{issue.author}</dd>
          <dt className="text-muted-foreground">{t("forge.updatedAt")}</dt>
          <dd className="min-w-0 truncate">
            {when(issue.updatedAtMs, locale)}
          </dd>
        </dl>
      </div>
      <Body text={issue.body} />
    </>
  );
}

function PullDetail({
  repo,
  scope,
  number,
  locale,
  onBack,
}: {
  repo: ForgeRepo;
  scope: ForgeScope;
  number: number;
  locale: string;
  onBack: () => void;
}) {
  const pull = useQuery({
    queryKey: forgeKeys.pull(repo, number, scope),
    queryFn: () => forgePull(repo, number, scope),
    retry: false,
  });
  return (
    <div
      className="flex min-w-0 flex-col gap-(--space-block) p-(--space-page)"
      data-slot="forge-pull-detail"
    >
      <Back onBack={onBack} url={pull.data?.url ?? ""} />
      {pull.isError && <Failure error={pull.error} />}
      {pull.isLoading && <ForgeDetailLoading />}
      {pull.data && <PullBody pull={pull.data} locale={locale} />}
    </div>
  );
}

export function PullBody({
  pull,
  locale,
}: {
  pull: ForgePull;
  locale: string;
}) {
  const t = useT();
  return (
    <>
      <div className="flex min-w-0 flex-col gap-(--space-group)">
        <Heading number={pull.number} title={pull.title} />
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge variant="secondary">{t(`forge.state.${pull.state}`)}</Badge>
          {pull.draft && <Badge variant="outline">{t("forge.draft")}</Badge>}
        </div>
        <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
          <dt className="text-muted-foreground">{t("forge.pull.branches")}</dt>
          <dd className="min-w-0 truncate font-mono">
            {pull.headRef} → {pull.baseRef}
          </dd>
          <dt className="text-muted-foreground">{t("forge.author")}</dt>
          <dd className="min-w-0 truncate">{pull.author}</dd>
          <dt className="text-muted-foreground">{t("forge.updatedAt")}</dt>
          <dd className="min-w-0 truncate">{when(pull.updatedAtMs, locale)}</dd>
        </dl>
      </div>
      <Body text={pull.body} />
    </>
  );
}
