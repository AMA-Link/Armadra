import * as React from "react";

import { Button } from "@/ui/button";
import { proposePlanFromNative } from "@/panels/automation/open";
import { featureEnabled } from "@/lib/features";
import { useAgentStatus } from "@/agent/status-store";
import { useSubagentCards } from "@/agent/subagent-store";
import { useCanvasStore } from "@/store/canvas-store";
import { usePreferencesStore, useT } from "@/app/preferences-store";
import { NodeShell } from "./NodeShell";
import type { NodeBodyProps } from "./registry";

/**
 * 原生活动观察卡片（自动化设计 §3）。
 *
 * 只读：数据来自已有的 Hook 事件（agent status 与 subagent 事件），这张卡不
 * 暂停、不取消、也不触发任何执行——隐藏它不会动 CLI 自己的循环。它与
 * `automation` 是两种实体，互不转换，免得同一个任务被双重触发。
 */
export function AgentActivityNode({ id, node, selected }: NodeBodyProps) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const data = node.data.kind === "agentActivity" ? node.data : null;
  const sourceId = data?.sourceNodeId ?? "";
  const source = useCanvasStore((state) =>
    state.document?.nodes.find((candidate) => candidate.id === sourceId),
  );
  const status = useAgentStatus(sourceId);
  const cards = useSubagentCards(sourceId);
  // A platform plan needs a live Agent terminal to name as its target. A card
  // whose source has no session yet cannot produce one, and saying so beats a
  // button that opens a form nothing can be selected in.
  const canConvert =
    source?.data.kind === "terminal" &&
    Boolean(source.data.agent?.id) &&
    Boolean(source.data.sessionId) &&
    !source.data.ssh;

  // Both sources read the same Hook stream; the label says which lens it is.
  // Nothing is synthesised here — a CLI whose loop we cannot observe shows zero.
  const latest = cards[cards.length - 1];
  const clock = React.useMemo(
    () => new Intl.DateTimeFormat(locale, { timeStyle: "medium" }),
    [locale],
  );

  return (
    <NodeShell
      node={node}
      selected={selected}
      {...(status?.state === "working" ? { glow: "working" as const } : {})}
    >
      <div
        data-slot="agent-activity-card"
        data-node-id={id}
        className="min-w-0 space-y-2 px-3 py-2 text-[12px]"
      >
        {!source ? (
          <p role="status" className="text-muted-foreground">
            {t("activity.missingSource")}
          </p>
        ) : (
          <>
            <span className="block min-w-0 truncate font-medium">
              {source.title}
            </span>
            <p className="text-muted-foreground">
              {t("activity.iterations", { count: cards.length })}
            </p>
            {latest ? (
              <div className="min-w-0 space-y-1">
                <p className="text-muted-foreground">{t("activity.latest")}</p>
                <p className="min-w-0 truncate">{latest.taskLabel}</p>
                <p className="text-[11px] text-muted-foreground">
                  {clock.format(latest.startedAt)}
                </p>
              </div>
            ) : (
              <p className="text-muted-foreground">{t("activity.none")}</p>
            )}
            {/* 定时任务暂时下线（#295）时没有「转为平台计划」的去处，整段不出。 */}
            {featureEnabled("scheduledTasks") ? (
              <>
                {/*
                  「转为平台计划」不是转换：这张卡片和它观察的 CLI 循环都留在原处，
                  点它只是把创建向导预填好打开，由人确认后建一份**草稿**。自动复制
                  成一份已启用的平台计划会让同一件事被触发两次。
                */}
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="min-h-8 w-full"
                  disabled={!canConvert}
                  title={
                    canConvert ? undefined : t("activity.convertUnavailable")
                  }
                  onClick={() =>
                    proposePlanFromNative({
                      targetKind: "agent",
                      nodeId: sourceId,
                      title: source.title,
                      origin: "native",
                      // 卡片读到过的重复规则原样带过去；能翻的向导会预填，翻不
                      // 动的把原文摆出来（`native-recurrence.ts`）。没读到规则的
                      // 卡片什么也不带——不给它编一个。
                      ...(data?.nativeRecurrence
                        ? { recurrence: data.nativeRecurrence }
                        : {}),
                    })
                  }
                >
                  {t("activity.convert")}
                </Button>
              </>
            ) : null}
          </>
        )}
      </div>
    </NodeShell>
  );
}
