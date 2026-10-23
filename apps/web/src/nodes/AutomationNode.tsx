import { AutomationPlanState } from "../api/automations";
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, ListOrdered, Pause, Play } from "lucide-react";

import { Badge } from "@/ui/badge";
import { IconButton } from "@/ui/icon-button";
import { StatusPill, type StatusTone } from "@/ui/status-pill";
import { useAutomationSession } from "@/host/automation-session";
import {
  digestLabel,
  instant,
  planStateKey,
  receiptPhase,
  runStateKey,
  scheduleKind,
} from "@/panels/automation/model";
import {
  automationKeys,
  allPlans,
  findPlan,
  runPage,
} from "@/panels/automation/queries";
import { openAutomationPanel } from "@/panels/automation/open";
import { featureEnabled } from "@/lib/features";
import { usePreferencesStore, useT } from "@/app/preferences-store";
import { AutomationSkeleton } from "./NodeSkeletons";
import { NodeShell } from "./NodeShell";
import type { NodeBodyProps } from "./registry";

/** 计划状态 → 状态族色调：已启用走蓝（不脉冲），已暂停走暂停灰，其余是空闲。 */
const PLAN_TONE: Partial<Record<AutomationPlanState, StatusTone>> = {
  [AutomationPlanState.ACTIVE]: "working",
  [AutomationPlanState.PAUSED]: "paused",
};

/**
 * 平台定时计划卡片（自动化设计 §3）。
 *
 * 卡片只存 `planId`：状态、下次执行和最近收据都从 Host 现读。Host 连不上时
 * 显示不可用原因而不是空白计划，投递过的运行也绝不画成「已完成」。
 */
export function AutomationNode({ id, node, selected }: NodeBodyProps) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const data = node.data.kind === "automation" ? node.data : null;
  const state = useAutomationSession((store) => store.state);
  const connect = useAutomationSession((store) => store.connect);
  const workspaceId = data?.planWorkspaceId ?? null;

  React.useEffect(() => {
    if (state.status === "idle" && workspaceId) void connect(workspaceId);
  }, [connect, state.status, workspaceId]);

  const client = state.status === "ready" ? state.client : null;
  const canManage = state.status === "ready" && state.canManage;

  const plans = useQuery({
    queryKey: automationKeys.plans(workspaceId ?? ""),
    queryFn: () => allPlans(client!),
    enabled: Boolean(client),
    retry: false,
    refetchInterval: 15_000,
  });
  const snapshot = findPlan(plans.data, data?.planId ?? "");
  // The card only ever shows the most recent receipt, and the Host already
  // orders its history newest first, so one page is the whole question.
  const runs = useQuery({
    queryKey: automationKeys.runs(workspaceId ?? "", data?.planId ?? ""),
    queryFn: () => runPage(client!, data!.planId, ""),
    enabled: Boolean(client && snapshot),
    retry: false,
    refetchInterval: 15_000,
  });
  const latest = runs.data?.runs[0]?.run;
  const plan = snapshot?.plan;
  const kind = scheduleKind(plan?.config) ?? data?.scheduleKind ?? null;
  const zone =
    plan?.config?.schedule?.kind?.case === "cron"
      ? plan.config.schedule.kind.value.timezone
      : data?.timezone;

  const unavailable =
    state.status === "blocked"
      ? `automation.blocked.${state.reason}`
      : state.status === "ready" && plans.isError
        ? "automation.error.network"
        : state.status === "ready" && plans.isSuccess && !snapshot
          ? "automation.error.notFound"
          : null;

  const headerActions = (
    <>
      <IconButton
        label={t("automation.viewRuns")}
        onClick={() => openAutomationPanel(data?.planId ?? null)}
      >
        <ListOrdered />
      </IconButton>
      {/* 无权限或读不到计划时不给假按钮：按钮直接不渲染。 */}
      {canManage && snapshot && plan?.state === AutomationPlanState.ACTIVE && (
        <IconButton
          label={t("automation.pause")}
          onClick={() => openAutomationPanel(plan.id)}
        >
          <Pause />
        </IconButton>
      )}
      {canManage && snapshot && plan?.state !== AutomationPlanState.ACTIVE && (
        <IconButton
          label={t("automation.activate")}
          onClick={() => openAutomationPanel(plan?.id ?? null)}
        >
          <Play />
        </IconButton>
      )}
    </>
  );

  return (
    <NodeShell
      node={node}
      selected={selected}
      headerChips={
        <Badge variant="outline">
          {t(
            kind
              ? `automation.schedule.${kind}`
              : "automation.schedule.unknown",
          )}
        </Badge>
      }
      // 定时任务暂时下线（#295）：旧画布里的卡片照常显示，但不给打开自动化
      // 抽屉的按钮——那块抽屉现在打不开。
      {...(featureEnabled("scheduledTasks") ? { headerActions } : {})}
      {...(plan?.needsAttention ? { glow: "attention" as const } : {})}
    >
      <div
        data-slot="automation-card"
        data-node-id={id}
        className="min-w-0 space-y-2 px-3 py-2 text-meta"
      >
        {unavailable ? (
          <p role="status" className="text-muted-foreground">
            {t(unavailable)}
          </p>
        ) : !plan ? (
          <AutomationSkeleton />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill
                size="sm"
                tone={PLAN_TONE[plan.state] ?? "idle"}
                pulse={false}
                label={t(planStateKey(plan))}
              />
              {plan.needsAttention && (
                <StatusPill
                  size="sm"
                  tone="attention"
                  label={t("automation.needsAttention")}
                />
              )}
            </div>
            <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">
                {t("automation.nextDue")}
              </dt>
              <dd className="min-w-0 truncate">
                {instant(plan.nextDueUnixMs, locale, zone) ??
                  t("automation.unknownTime")}
              </dd>
              <dt className="text-muted-foreground">
                {t("automation.lastRun")}
              </dt>
              <dd className="min-w-0 truncate">
                {latest ? t(runStateKey(latest)) : t("automation.emptyRuns")}
              </dd>
              {latest && (
                <>
                  <dt className="text-muted-foreground">
                    {t("automation.run.receipt")}
                  </dt>
                  <dd className="min-w-0 truncate">
                    {t(`automation.receipt.${receiptPhase(latest)}`)}
                  </dd>
                </>
              )}
              {zone && (
                <>
                  <dt className="text-muted-foreground">
                    {t("automation.timezone")}
                  </dt>
                  <dd className="min-w-0 truncate">{zone}</dd>
                </>
              )}
            </dl>
            <p className="truncate font-mono text-caption text-muted-foreground select-text">
              {digestLabel(snapshot?.configSha256).slice(0, 16)}
            </p>
          </>
        )}
      </div>
    </NodeShell>
  );
}
