import { Check, GitCommitHorizontal, Minus, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { Avatar, AvatarFallback } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { useT } from "@/app/preferences-store";
import { openExternal } from "@/platform";
import type {
  ForgeCommit,
  ForgeFile,
  ForgePullItem,
  ForgeRepo,
  ForgeReviewer,
} from "../../api/forge";
import { ForgeChecksSummary } from "./ForgeChecksSummary";
import { when } from "./forge-keys";

/**
 * PR 概览的几块：信息表（作者、审查者、指派、标签、里程碑、关联、改动）、合并
 * 状态卡（审查结论、检查汇总、冲突）与提交列表。新字段旧 core 不给时，对应行
 * 不画，其余照常。
 */

export function Person({
  login,
  children,
}: {
  login: string;
  children?: React.ReactNode;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Avatar size="sm" className="size-5">
        <AvatarFallback className="text-caption">
          {login.slice(0, 1).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0 truncate">{login}</span>
      {children}
    </span>
  );
}

const ASSOCIATIONS = [
  "owner",
  "member",
  "collaborator",
  "contributor",
  "firstTimeContributor",
  "firstTimer",
];

const REVIEWER_TONE = {
  approved: "text-success-text",
  changesRequested: "text-warn-text",
  commented: "text-muted-foreground",
  pending: "text-muted-foreground",
  dismissed: "text-muted-foreground",
} as const;

function ReviewerRow({ reviewer }: { reviewer: ForgeReviewer }) {
  const t = useT();
  const Icon =
    reviewer.state === "approved"
      ? Check
      : reviewer.state === "changesRequested"
        ? X
        : Minus;
  return (
    <li
      data-slot="forge-reviewer"
      data-state={reviewer.state}
      className="flex min-w-0 items-center gap-2"
    >
      <Person login={reviewer.login} />
      <span
        className={cn(
          "ml-auto inline-flex shrink-0 items-center gap-1 text-meta",
          REVIEWER_TONE[reviewer.state],
        )}
      >
        <Icon aria-hidden className="size-3.5" />
        {t(`forge.reviewer.${reviewer.state}`)}
      </span>
    </li>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <dt className="pt-0.5 text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1.5">
        {children}
      </dd>
    </>
  );
}

export function PullInfo({
  pull,
  reviewers,
  linkedIssues,
  files: fileList,
}: {
  pull: ForgePullItem;
  reviewers: readonly ForgeReviewer[];
  linkedIssues: readonly number[];
  files: readonly ForgeFile[];
}) {
  const t = useT();
  // 列表字段旧 core 不给：用改动文件页的合计顶上。
  const sum = (key: "additions" | "deletions") =>
    fileList.length > 0
      ? fileList.reduce((total, file) => total + file[key], 0)
      : null;
  const additions = pull.additions ?? sum("additions");
  const deletions = pull.deletions ?? sum("deletions");
  const files =
    pull.changedFiles ?? (fileList.length > 0 ? fileList.length : null);
  const hasDiff = additions !== null || deletions !== null;
  return (
    <dl
      data-slot="forge-pull-info"
      className="grid min-w-0 grid-cols-[4.5rem_1fr] gap-x-3 gap-y-2 text-body"
    >
      {pull.author && (
        <Row label={t("forge.author")}>
          <Person login={pull.author} />
          {pull.authorAssociation && (
            <Badge variant="outline" size="sm">
              {ASSOCIATIONS.includes(pull.authorAssociation)
                ? t(`forge.association.${pull.authorAssociation}`)
                : pull.authorAssociation}
            </Badge>
          )}
        </Row>
      )}
      {reviewers.length > 0 && (
        <>
          <dt className="pt-0.5 text-muted-foreground">
            {t("forge.reviewers")}
          </dt>
          <dd className="min-w-0">
            <ul className="flex min-w-0 flex-col gap-1.5">
              {reviewers.map((reviewer) => (
                <ReviewerRow key={reviewer.login} reviewer={reviewer} />
              ))}
            </ul>
          </dd>
        </>
      )}
      {pull.assignees.length > 0 && (
        <Row label={t("forge.assignees")}>
          {pull.assignees.map((login) => (
            <Person key={login} login={login} />
          ))}
        </Row>
      )}
      {pull.labels.length > 0 && (
        <Row label={t("forge.labels")}>
          {pull.labels.map((label) => (
            <Badge key={label} variant="outline" size="sm">
              {label}
            </Badge>
          ))}
        </Row>
      )}
      {pull.milestone && (
        <Row label={t("forge.milestone")}>
          <span className="min-w-0 truncate">{pull.milestone}</span>
        </Row>
      )}
      {linkedIssues.length > 0 && (
        <Row label={t("forge.linked")}>
          {linkedIssues.map((n) => (
            <Badge key={n} variant="outline" size="sm">
              {t("forge.pull.closes", { number: n })}
            </Badge>
          ))}
        </Row>
      )}
      {(hasDiff || files !== null) && (
        <Row label={t("forge.changes")}>
          <span className="tabular-nums" data-slot="forge-pull-diff">
            {additions !== null && (
              <span className="text-success-text">+{additions}</span>
            )}{" "}
            {deletions !== null && (
              <span className="text-danger-text">−{deletions}</span>
            )}
          </span>
          {files !== null && (
            <span className="text-muted-foreground">
              · {t("forge.files.count", { count: files })}
            </span>
          )}
        </Row>
      )}
    </dl>
  );
}

/** 合并状态卡：审查结论、检查汇总（可展开）、冲突，三行一张卡。 */
export function MergeStatus({
  pull,
  repo,
  reviewers,
}: {
  pull: ForgePullItem;
  repo: ForgeRepo;
  reviewers: readonly ForgeReviewer[];
}) {
  const t = useT();
  const requested = reviewers.filter(
    (entry) => entry.state === "changesRequested",
  ).length;
  const approved = reviewers.filter(
    (entry) => entry.state === "approved",
  ).length;
  const detail = [
    requested > 0 ? t("forge.merge.requested", { count: requested }) : null,
    approved > 0 ? t("forge.merge.approved", { count: approved }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const decision = pull.reviewDecision;
  const hasConflict = pull.mergeable === "conflicting";
  const clean = pull.mergeable === "mergeable";
  if (pull.state !== "open") return null;
  return (
    <section
      data-slot="forge-merge-status"
      className="flex min-w-0 flex-col divide-y divide-border rounded-card border border-border"
    >
      {decision && (
        <div
          data-slot="forge-merge-review"
          data-decision={decision}
          className="flex min-w-0 flex-col gap-0.5 px-3 py-2"
        >
          <span
            className={cn(
              "font-medium",
              decision === "approved" ? "text-success-text" : "text-warn-text",
            )}
          >
            {t(`forge.review.decision.${decision}`)}
          </span>
          {detail && (
            <span className="text-meta text-muted-foreground">{detail}</span>
          )}
        </div>
      )}
      <ForgeChecksSummary
        repo={repo}
        number={pull.number}
        className="rounded-none border-0"
      />
      {(hasConflict || clean) && (
        <div
          data-slot="forge-merge-conflict"
          data-conflict={hasConflict}
          className={cn(
            "px-3 py-2 text-body",
            hasConflict ? "text-danger-text" : "text-success-text",
          )}
        >
          {t(hasConflict ? "forge.merge.conflict" : "forge.merge.clean", {
            base: pull.baseRef,
          })}
        </div>
      )}
    </section>
  );
}

export function CommitList({
  commits,
  locale,
}: {
  commits: readonly ForgeCommit[];
  locale: string;
}) {
  const t = useT();
  if (commits.length === 0)
    return (
      <p className="text-meta text-muted-foreground">{t("forge.empty")}</p>
    );
  return (
    <ul
      data-slot="forge-commits"
      className="min-w-0 divide-y divide-border rounded-card border border-border"
    >
      {commits.map((commit) => (
        <li
          key={commit.sha}
          data-slot="forge-commit"
          className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-meta"
        >
          <GitCommitHorizontal
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground"
          />
          <span className="min-w-0 flex-1 truncate text-body">
            {commit.title}
          </span>
          <span className="hidden shrink-0 text-muted-foreground sm:inline">
            {[commit.author, when(commit.authoredAtMs, locale)]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {/^https?:\/\//i.test(commit.url) ? (
            <a
              href={commit.url}
              target="_blank"
              rel="noreferrer noopener"
              className="shrink-0 font-mono hover:underline"
              onClick={(event) => {
                event.preventDefault();
                void openExternal(commit.url);
              }}
            >
              {commit.sha.slice(0, 7)}
            </a>
          ) : (
            <span className="shrink-0 font-mono">{commit.sha.slice(0, 7)}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
