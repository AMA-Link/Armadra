import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink } from "lucide-react";

import { CommentBody } from "@/realtime/comments/CommentBody";
import { Loadable } from "@/loading/Loadable";
import { Badge } from "@/ui/badge";
import { IconButton } from "@/ui/icon-button";
import { Skeleton } from "@/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
import { useT } from "@/app/preferences-store";
import { openExternal } from "@/platform";
import {
  type ForgeConversationItem,
  type ForgeFile,
  type ForgeIssue,
  type ForgePull,
  type ForgeRepo,
  type ForgeScope,
  forgeFailureKey,
  forgeIssue,
  forgeIssueComments,
  forgePull,
  forgePullComments,
  forgePullFiles,
} from "../../api/forge";
import { ForgeChecksSummary } from "./ForgeChecksSummary";
import { ForgeStateBadge } from "./ForgeStateBadge";
import { forgeKeys, when } from "./forge-keys";

/**
 * 面板里一条 issue / PR 的详情（只读）：Markdown 正文、评论时间线；PR 另有概览
 * （检查、改动文件、评审意见）、文件与动态三页。正文与评论是别人写的材料：
 * 经 {@link CommentBody} 渲染，不执行 HTML，链接只放行 http(s)。
 */

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

export function Failure({ error }: { error: unknown }) {
  const t = useT();
  return (
    <p
      role="status"
      data-slot="forge-failure"
      className="px-3 py-2 text-meta text-destructive"
    >
      {t(forgeFailureKey(error))}
    </p>
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
    <h3 className="min-w-0 text-section font-semibold break-words">
      <span className="mr-2 tabular-nums text-muted-foreground">#{number}</span>
      {title}
    </h3>
  );
}

function Body({ text }: { text: string }) {
  if (!text.trim()) return null;
  return <CommentBody body={text} className="min-w-0 select-text" />;
}

/* -------------------------------- 讨论时间线 -------------------------------- */

const REVIEW_VARIANT = {
  approved: "success",
  changes_requested: "warn",
  commented: "secondary",
} as const;

function ReviewMark({ state }: { state: string | null }) {
  const t = useT();
  if (!state) return null;
  const known = state in REVIEW_VARIANT;
  return (
    <Badge
      data-slot="forge-review-state"
      data-state={state}
      variant={
        known ? REVIEW_VARIANT[state as keyof typeof REVIEW_VARIANT] : "outline"
      }
      size="sm"
    >
      {known ? t(`forge.review.${state}`) : state}
    </Badge>
  );
}

function Conversation({
  items,
  locale,
}: {
  items: readonly ForgeConversationItem[];
  locale: string;
}) {
  return (
    <ol className="flex min-w-0 flex-col gap-2" data-slot="forge-timeline">
      {items.map((item) => (
        <li
          key={item.id}
          data-slot="forge-comment"
          data-kind={item.kind}
          className="flex min-w-0 flex-col gap-1 rounded-card border border-border px-3 py-2"
        >
          <div className="flex min-w-0 items-center gap-2 text-meta text-muted-foreground">
            <span className="min-w-0 truncate font-medium text-foreground">
              {item.author ?? ""}
            </span>
            <span className="shrink-0">{when(item.createdAtMs, locale)}</span>
            <ReviewMark state={item.kind === "review" ? item.state : null} />
          </div>
          <Body text={item.body} />
        </li>
      ))}
    </ol>
  );
}

function ConversationPanel({
  query,
  locale,
  only,
}: {
  query: {
    data?: ForgeConversationItem[];
    isError: boolean;
    error: unknown;
    isLoading: boolean;
  };
  locale: string;
  only?: ForgeConversationItem["kind"];
}) {
  const t = useT();
  if (query.isError) return <Failure error={query.error} />;
  if (query.isLoading) return <ForgeDetailLoading />;
  const items = (query.data ?? []).filter(
    (item) =>
      (only === undefined || item.kind === only) && (item.body || item.state),
  );
  if (items.length === 0)
    return only ? null : (
      <p className="text-meta text-muted-foreground">{t("forge.empty")}</p>
    );
  return <Conversation items={items} locale={locale} />;
}

/* --------------------------------- Issue --------------------------------- */

export function IssueDetail({
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
  const comments = useQuery({
    queryKey: forgeKeys.issueComments(repo, number, scope),
    queryFn: () => forgeIssueComments(repo, number, scope),
    enabled: Boolean(issue.data),
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
      {issue.data && (
        <>
          <IssueBody issue={issue.data} locale={locale} />
          {issue.data.commentCount > 0 || (comments.data?.length ?? 0) > 0 ? (
            <ConversationPanel query={comments} locale={locale} />
          ) : null}
        </>
      )}
    </div>
  );
}

export function IssueBody({
  issue,
  locale,
}: {
  issue: ForgeIssue;
  locale: string;
}) {
  const t = useT();
  return (
    <>
      <div className="flex min-w-0 flex-col gap-(--space-group)">
        <Heading number={issue.number} title={issue.title} />
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <ForgeStateBadge state={issue.state} />
          {issue.labels.map((label) => (
            <Badge key={label} variant="outline" size="sm">
              {label}
            </Badge>
          ))}
        </div>
        <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-meta">
          <dt className="text-muted-foreground">{t("forge.author")}</dt>
          <dd className="min-w-0 truncate">{issue.author}</dd>
          <dt className="text-muted-foreground">{t("forge.comments")}</dt>
          <dd className="min-w-0 truncate tabular-nums">
            {issue.commentCount}
          </dd>
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

/* ----------------------------------- PR ----------------------------------- */

const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;

/** 描述里的 `Closes #n` / `Fixes #n`：去重，按出现顺序。 */
export function closedIssues(body: string): number[] {
  const seen = new Set<number>();
  for (const match of body.matchAll(CLOSES)) seen.add(Number(match[1]));
  return [...seen];
}

const STATUS_LETTER: Record<ForgeFile["status"], string> = {
  added: "A",
  modified: "M",
  removed: "D",
  renamed: "R",
  other: "·",
};

function Stat({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  return (
    <span className="shrink-0 tabular-nums">
      <span className="text-success-text">+{additions}</span>{" "}
      <span className="text-danger-text">−{deletions}</span>
    </span>
  );
}

/** 改动文件卡片：A / M / D 的个数与总增删行。 */
function FilesCard({ files }: { files: readonly ForgeFile[] }) {
  const t = useT();
  if (files.length === 0) return null;
  const count = (status: ForgeFile["status"]) =>
    files.filter((file) => file.status === status).length;
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return (
    <div
      data-slot="forge-files-card"
      className="flex min-w-0 items-center gap-2 rounded-card border border-border px-3 py-2 text-body"
    >
      <span className="min-w-0 truncate font-medium">
        {t("forge.files.count", { count: files.length })}
      </span>
      {(["added", "modified", "removed"] as const).map((status) => {
        const n = count(status);
        return n > 0 ? (
          <Badge key={status} variant="secondary" size="sm">
            {STATUS_LETTER[status]} {n}
          </Badge>
        ) : null;
      })}
      <span className="ml-auto">
        <Stat additions={additions} deletions={deletions} />
      </span>
    </div>
  );
}

function FileList({ files }: { files: readonly ForgeFile[] }) {
  return (
    <ul className="min-w-0 divide-y divide-border rounded-card border border-border">
      {files.map((file) => (
        <li
          key={file.path}
          data-slot="forge-file"
          className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-meta"
        >
          <Badge variant="secondary" size="sm" data-status={file.status}>
            {STATUS_LETTER[file.status]}
          </Badge>
          <span
            title={
              file.previousPath
                ? `${file.previousPath} → ${file.path}`
                : file.path
            }
            className="min-w-0 flex-1 truncate font-mono"
          >
            {file.path}
          </span>
          <Stat additions={file.additions} deletions={file.deletions} />
        </li>
      ))}
    </ul>
  );
}

export function PullDetail({
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
  const t = useT();
  const pull = useQuery({
    queryKey: forgeKeys.pull(repo, number, scope),
    queryFn: () => forgePull(repo, number, scope),
    retry: false,
  });
  const files = useQuery({
    queryKey: forgeKeys.pullFiles(repo, number),
    queryFn: () => forgePullFiles(repo, number),
    enabled: Boolean(pull.data),
    retry: false,
  });
  const comments = useQuery({
    queryKey: forgeKeys.pullComments(repo, number, scope),
    queryFn: () => forgePullComments(repo, number, scope),
    enabled: Boolean(pull.data),
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
      {pull.data && (
        <>
          <PullBody pull={pull.data} locale={locale} />
          <Tabs defaultValue="overview" className="min-w-0 gap-(--space-block)">
            <TabsList variant="line" className="w-full">
              <TabsTrigger value="overview" className="min-w-0 text-meta">
                {t("forge.pull.overview")}
              </TabsTrigger>
              <TabsTrigger value="files" className="min-w-0 text-meta">
                {t("forge.pull.files")}
              </TabsTrigger>
              <TabsTrigger value="activity" className="min-w-0 text-meta">
                {t("forge.pull.activity")}
              </TabsTrigger>
            </TabsList>
            <TabsContent
              value="overview"
              className="flex min-w-0 flex-col gap-(--space-block)"
            >
              <ForgeChecksSummary repo={repo} number={number} />
              <FilesCard files={files.data ?? []} />
              <Body text={pull.data.body} />
              <ConversationPanel
                query={comments}
                locale={locale}
                only="review"
              />
            </TabsContent>
            <TabsContent value="files" className="min-w-0">
              {files.isError ? (
                <Failure error={files.error} />
              ) : (
                <FileList files={files.data ?? []} />
              )}
            </TabsContent>
            <TabsContent value="activity" className="min-w-0">
              <ConversationPanel query={comments} locale={locale} />
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}

/** PR 的头部：标题、状态、`base ← head`、`Closes #n`、作者与时间。 */
export function PullBody({
  pull,
  locale,
}: {
  pull: ForgePull;
  locale: string;
}) {
  const t = useT();
  const closes = closedIssues(pull.body);
  return (
    <div className="flex min-w-0 flex-col gap-(--space-group)">
      <Heading number={pull.number} title={pull.title} />
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <ForgeStateBadge state={pull.state} draft={pull.draft} />
        {closes.map((n) => (
          <Badge key={n} variant="outline" size="sm">
            {t("forge.pull.closes", { number: n })}
          </Badge>
        ))}
      </div>
      <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-meta">
        <dt className="text-muted-foreground">{t("forge.pull.branches")}</dt>
        <dd className="min-w-0 truncate font-mono">
          {pull.baseRef} ← {pull.headRef}
        </dd>
        <dt className="text-muted-foreground">{t("forge.author")}</dt>
        <dd className="min-w-0 truncate">{pull.author}</dd>
        <dt className="text-muted-foreground">{t("forge.updatedAt")}</dt>
        <dd className="min-w-0 truncate">{when(pull.updatedAtMs, locale)}</dd>
      </dl>
    </div>
  );
}
