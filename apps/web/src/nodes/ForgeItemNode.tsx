import { useQuery } from "@tanstack/react-query";

import { cn } from "@/lib/cn";
import { useT, usePreferencesStore } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { Skeleton } from "@/ui/skeleton";
import {
  type ForgeRepo,
  detectForge,
  forgeIssue,
  forgePull,
} from "../api/forge";
import { Failure } from "@/panels/github/ForgeDetail";
import { ForgeChecksSummary } from "@/panels/github/ForgeChecksSummary";
import { ForgeItemRow } from "@/panels/github/ForgeItemRow";
import { forgeKeys } from "@/panels/github/forge-keys";
import { openGithubPanel } from "@/panels/github/open";
import { sk } from "../sources/scope";
import { NodeShell } from "./NodeShell";
import type { NodeBodyProps } from "./registry";

const REVIEW_TONE = {
  approved: "text-success-text",
  changesRequested: "text-warn-text",
  reviewRequired: "text-warn-text",
} as const;

/**
 * 「加到画板」的单条 Issue / PR 卡片（#934）：状态胶囊加列表里同一个条目行，
 * PR 另有检查汇总与审查结论；点条目在侧边面板打开详情。节点只记仓库坐标、种类与
 * 编号，标题与状态从托管平台现读（与面板详情同一份缓存）。
 */
export function ForgeItemNode({ node, selected }: NodeBodyProps) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? null);
  const data = node.data.kind === "forgeItem" ? node.data : null;
  const repo: ForgeRepo | null = data
    ? { host: data.repo.host, owner: data.repo.owner, name: data.repo.name }
    : null;
  // 数据不是卡片（不该发生）时用空坐标占住查询键，查询本身关着。
  const ref: ForgeRepo = repo ?? { host: "", owner: "", name: "" };
  const number = data?.number ?? 0;
  const isPull = data?.itemKind === "pull";

  const pullQuery = useQuery({
    queryKey: forgeKeys.pull(ref, number, workspaceId),
    queryFn: () => forgePull(ref, number, workspaceId),
    enabled: repo !== null && isPull,
    retry: false,
  });
  const issueQuery = useQuery({
    queryKey: forgeKeys.issue(ref, number, workspaceId),
    queryFn: () => forgeIssue(ref, number, workspaceId),
    enabled: repo !== null && !isPull,
    retry: false,
  });
  const item = isPull ? pullQuery : issueQuery;
  // 打开详情要带上平台种类；认仓库的结果在面板里也是这份缓存。
  const detection = useQuery({
    queryKey: sk(
      "forge",
      "detect-repo",
      workspaceId ?? "",
      repo?.host ?? "",
      repo?.owner ?? "",
      repo?.name ?? "",
    ),
    queryFn: () => detectForge(ref, workspaceId),
    enabled: repo !== null,
    retry: false,
  });

  const open = () => {
    if (!repo) return;
    openGithubPanel(isPull ? "pulls" : "issues", BigInt(number), {
      forge: detection.data?.forge ?? "github",
      ...repo,
    });
  };
  const decision = pullQuery.data?.reviewDecision ?? null;

  return (
    <NodeShell node={node} selected={selected}>
      <div
        data-slot="forge-item-node"
        className="flex h-full min-h-0 min-w-0 flex-col gap-2 overflow-y-auto p-(--space-page)"
      >
        {repo && (
          <span className="min-w-0 truncate text-caption text-muted-foreground select-text">
            {repo.owner}/{repo.name}#{number}
          </span>
        )}
        {item.isError && <Failure error={item.error} />}
        {item.isLoading && <Skeleton className="h-14 w-full" />}
        {item.data && (
          <ForgeItemRow
            kind={isPull ? "pull" : "issue"}
            item={item.data}
            locale={locale}
            onOpen={open}
          />
        )}
        {isPull && repo && item.data && (
          <ForgeChecksSummary repo={repo} number={number} />
        )}
        {decision && (
          <span
            data-slot="forge-item-review"
            data-decision={decision}
            className={cn("text-meta font-medium", REVIEW_TONE[decision])}
          >
            {t(`forge.review.decision.${decision}`)}
          </span>
        )}
      </div>
    </NodeShell>
  );
}
