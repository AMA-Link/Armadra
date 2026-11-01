import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import type { WorkItemStage } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { StatusPill } from "@/ui/status-pill";
import { type DispatchTask, coordinatorApi, coordinatorKeys } from "./api";
import { STAGE_STATUS, isPersonStage } from "./model";

/**
 * 成员节点头部的阶段（契约 §90.4）：协调者分派出去的工作项此刻在哪一阶段。
 * 任务行每块画板取一次（与分派抽屉同一个查询键，`workflow.task` 帧到了由
 * `useWorkflowEvents` 失效重取），算成「节点 → 阶段」放进这张小表；节点只读
 * 表，不各自发请求。头部只在要人处理或排队时画；运行中、空闲已经有状态胶囊。
 */
export const useItemStages = create<{
  stages: Readonly<Record<string, WorkItemStage>>;
}>(() => ({ stages: {} }));

/** 每个成员节点最新一行任务的阶段。 */
export function nodeStages(
  tasks: readonly DispatchTask[],
): Record<string, WorkItemStage> {
  const latest = new Map<string, DispatchTask>();
  for (const task of tasks) {
    if (task.stage === null) continue;
    const seen = latest.get(task.nodeId);
    if (!seen || Date.parse(task.startedAt) > Date.parse(seen.startedAt)) {
      latest.set(task.nodeId, task);
    }
  }
  const stages: Record<string, WorkItemStage> = {};
  for (const [nodeId, task] of latest) stages[nodeId] = task.stage!;
  return stages;
}

/**
 * 取当前画板的任务行并写表。只在画板上有协调者（ama 节点）时才取。由常驻的
 * 草案层调用。
 */
export function useItemStageSync(): void {
  const boardId = useCanvasStore((state) => state.boardId);
  const hasCoordinator = useCanvasStore((state) =>
    (state.document?.nodes ?? []).some(
      (node) => node.data.kind === "terminal" && node.data.agent?.id === "ama",
    ),
  );
  const tasks = useQuery({
    queryKey: coordinatorKeys.tasks(boardId ?? ""),
    queryFn: () => coordinatorApi.tasks(boardId as string),
    enabled: Boolean(boardId) && hasCoordinator,
    retry: false,
  });
  const data = tasks.data;
  React.useEffect(() => {
    useItemStages.setState({ stages: data ? nodeStages(data) : {} });
  }, [data]);
}

/** 节点头部的阶段胶囊；没有阶段、或只是在运行 / 空闲时不画。 */
export function ItemStageBadge({ nodeId }: { nodeId: string }) {
  const t = useT();
  const stage = useItemStages((state) => state.stages[nodeId]);
  if (!stage || !(isPersonStage(stage) || stage === "working/queued")) {
    return null;
  }
  const status = STAGE_STATUS[stage];
  return (
    <StatusPill
      tone={status.tone}
      label={t(status.label)}
      data-slot="item-stage-badge"
      data-stage={stage}
    />
  );
}
