import { Check, Clock, MessageSquare, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { useT } from "@/app/preferences-store";
import type { ForgeChecksRollup, ForgeReviewDecision } from "../../api/forge";
import { when } from "./forge-keys";
import {
  ForgeStateBadge,
  ForgeStateIcon,
  type ForgeItemKind,
  type ForgeItemState,
} from "./ForgeStateBadge";

export interface ForgeItemRowItem {
  number: number;
  title: string;
  state: ForgeItemState;
  draft?: boolean;
  author: string | null;
  updatedAtMs: number;
  labels?: readonly string[];
  /** 列表的新字段（#934）：旧 core 不给时这一列不画。 */
  commentCount?: number;
  checks?: ForgeChecksRollup | null;
  reviewDecision?: ForgeReviewDecision;
}

const CI_TONE = {
  success: "text-success-text",
  failure: "text-danger-text",
  pending: "text-warn-text",
  neutral: "text-muted-foreground",
  none: "text-muted-foreground",
} as const;

/** 列表行右侧的 CI：图标加 `通过/总数`，没有检查就不画。 */
export function ForgeCiMark({ checks }: { checks: ForgeChecksRollup | null }) {
  const t = useT();
  if (!checks || checks.total === 0) return null;
  const Icon =
    checks.rollup === "success"
      ? Check
      : checks.rollup === "failure"
        ? X
        : Clock;
  return (
    <span
      data-slot="forge-row-ci"
      data-rollup={checks.rollup}
      title={t("forge.checks.summary", {
        passed: checks.passed,
        total: checks.total,
      })}
      className={cn(
        "inline-flex items-center gap-1 text-caption tabular-nums",
        CI_TONE[checks.rollup],
      )}
    >
      <Icon aria-hidden className="size-3.5" />
      {checks.passed}/{checks.total}
    </span>
  );
}

const REVIEW_DOT = {
  approved: "bg-success",
  changesRequested: "bg-warn",
  reviewRequired: "bg-warn",
} as const;

/** 审查结论圆点：已批准绿、要修改 / 待审查橙，没有结论不画（占位保持列对齐）。 */
export function ForgeReviewDot({
  decision,
}: {
  decision: ForgeReviewDecision | undefined;
}) {
  const t = useT();
  return (
    <span
      data-slot="forge-row-review"
      data-decision={decision ?? "none"}
      title={decision ? t(`forge.review.decision.${decision}`) : undefined}
      aria-label={decision ? t(`forge.review.decision.${decision}`) : undefined}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        decision ? REVIEW_DOT[decision] : "bg-transparent",
      )}
    />
  );
}

/**
 * 一条 issue / PR 的一行：状态图标、`#n`、标题、状态胶囊，下面作者、时间与标签。
 * 面板列表与画布徽标的悬浮卡是同一个组件；没有 `onOpen` 时是静态的一块。
 */
export function ForgeItemRow({
  kind,
  item,
  locale,
  onOpen,
  columns = true,
}: {
  kind: ForgeItemKind;
  item: ForgeItemRowItem;
  locale: string;
  onOpen?: () => void;
  /** 右侧的 CI、审查与评论列；看板与悬浮卡里可以关掉。 */
  columns?: boolean;
}) {
  const meta = [item.author, when(item.updatedAtMs, locale)]
    .filter(Boolean)
    .join(" · ");
  const body = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <ForgeStateIcon kind={kind} state={item.state} draft={item.draft} />
        <span className="shrink-0 tabular-nums text-muted-foreground">
          #{item.number}
        </span>
        <span className="min-w-0 flex-1 truncate text-body font-medium">
          {item.title}
        </span>
        <ForgeStateBadge state={item.state} draft={item.draft} />
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-meta font-normal text-muted-foreground">
        <span className="min-w-0 truncate">{meta}</span>
        {(item.labels ?? []).slice(0, 3).map((label) => (
          <Badge key={label} variant="outline" size="sm" className="max-w-24">
            <span className="truncate">{label}</span>
          </Badge>
        ))}
        {columns && (
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {kind === "pull" && <ForgeCiMark checks={item.checks ?? null} />}
            {kind === "pull" && (
              <ForgeReviewDot decision={item.reviewDecision} />
            )}
            {item.commentCount !== undefined && (
              <span
                data-slot="forge-row-comments"
                className="inline-flex w-8 items-center gap-1 text-caption tabular-nums"
              >
                <MessageSquare aria-hidden className="size-3.5" />
                {item.commentCount}
              </span>
            )}
          </span>
        )}
      </span>
    </>
  );
  return (
    <article
      data-slot={`forge-${kind}`}
      data-number={item.number}
      className="min-w-0 rounded-card border border-border"
    >
      {onOpen ? (
        <Button
          variant="ghost"
          className="h-auto w-full min-w-0 flex-col items-stretch gap-1 px-3 py-2 text-left"
          onClick={onOpen}
        >
          {body}
        </Button>
      ) : (
        <div className="flex min-w-0 flex-col gap-1 px-3 py-2">{body}</div>
      )}
    </article>
  );
}
