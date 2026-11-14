import {
  CircleCheck,
  CircleDot,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from "lucide-react";

import { Badge } from "@/ui/badge";
import { useT } from "@/app/preferences-store";

export type ForgeItemKind = "issue" | "pull";
export type ForgeItemState = "open" | "closed" | "merged";

const VARIANT = {
  open: "success",
  closed: "secondary",
  merged: "brand",
} as const;

/** 条目前的状态图标：issue 与 PR 各一套，草稿 PR 单独一个。 */
export function ForgeStateIcon({
  kind,
  state,
  draft = false,
}: {
  kind: ForgeItemKind;
  state: ForgeItemState;
  draft?: boolean;
}) {
  const className = "size-4 shrink-0";
  if (kind === "issue")
    return state === "open" ? (
      <CircleDot aria-hidden className={`${className} text-success-text`} />
    ) : (
      <CircleCheck aria-hidden className={`${className} text-brand-text`} />
    );
  if (state === "merged")
    return <GitMerge aria-hidden className={`${className} text-brand-text`} />;
  if (state === "closed")
    return (
      <GitPullRequestClosed
        aria-hidden
        className={`${className} text-danger-text`}
      />
    );
  return draft ? (
    <GitPullRequestDraft
      aria-hidden
      className={`${className} text-muted-foreground`}
    />
  ) : (
    <GitPullRequest aria-hidden className={`${className} text-success-text`} />
  );
}

/** 开启 / 已关闭 / 已合并 / 草稿 胶囊；列表行、详情、画布徽标卡共用。 */
export function ForgeStateBadge({
  state,
  draft = false,
}: {
  state: ForgeItemState;
  draft?: boolean;
}) {
  const t = useT();
  const showDraft = draft && state === "open";
  return (
    <Badge
      data-slot="forge-state"
      data-state={showDraft ? "draft" : state}
      variant={showDraft ? "outline" : VARIANT[state]}
      size="sm"
    >
      {showDraft ? t("forge.draft") : t(`forge.state.${state}`)}
    </Badge>
  );
}
