import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import type { WorkItemStage } from "@armadra/shared";
import { create } from "zustand";

import { useT } from "@/app/preferences-store";
import { useAccess } from "@/app/use-access";
import { useCanvasStore } from "@/store/canvas-store";
import { Badge } from "@/ui/badge";
import { type DispatchTask, coordinatorApi, coordinatorKeys } from "./api";

/**
 * 成员节点头部的工作项阶段（#682）：协调者派给它的那一项在等人时（`person/*`），
 * 状态胶囊旁多一枚 `Badge`——待回答、待验收、阻塞、投递失败、本轮失败。其余阶段
 * 状态胶囊已经说清楚了，不重复画。
 *
 * 任务行每块画板只取一次（与分派抽屉同一个查询键，`workflow.*` 帧到了整组重读），
 * 算成「节点 → 阶段」放进这张小表；节点只读表，不各自发请求。画板上没有 ama
 * 节点就不取：没有协调者就没有工作项。
 */
export const useWorkItemStages = create<{
  stages: Readonly<Record<string, WorkItemStage>>;
}>(() => ({ stages: {} }));

/** 每个成员节点最新那一项的阶段，只留要人处理的。 */
export function personStages(
  tasks: readonly DispatchTask[],
): Record<string, WorkItemStage> {
  const latest = new Map<string, DispatchTask>();
  for (const task of tasks) {
    const seen = latest.get(task.nodeId);
    if (
      seen === undefined ||
      Date.parse(task.startedAt) > Date.parse(seen.startedAt)
    ) {
      latest.set(task.nodeId, task);
    }
  }
  const stages: Record<string, WorkItemStage> = {};
  for (const [nodeId, task] of latest) {
    if (task.stage?.startsWith("person/") === true) stages[nodeId] = task.stage;
  }
  return stages;
}

/** 取当前画板的任务行并写表；与 `useWorkflowStepSync` 一样由常驻的草案层调用。 */
export function useWorkItemStageSync(): void {
  const boardId = useCanvasStore((state) => state.boardId);
  const hasCoordinator = useCanvasStore(
    (state) =>
      state.document?.nodes.some(
        (node) =>
          node.data.kind === "terminal" && node.data.agent?.id === "ama",
      ) === true,
  );
  // 工作流路由对成员一律 403（契约 §15）：成员不取。
  const member = useAccess().member;
  const tasks = useQuery({
    queryKey: coordinatorKeys.tasks(boardId ?? ""),
    queryFn: () => coordinatorApi.tasks(boardId as string),
    enabled: Boolean(boardId) && hasCoordinator && !member,
    retry: false,
  });
  const data = tasks.data;
  React.useEffect(() => {
    useWorkItemStages.setState({ stages: data ? personStages(data) : {} });
  }, [data]);
}

const LABEL: Readonly<Partial<Record<WorkItemStage, string>>> = {
  "person/delivery": "coordinator.stage.delivery",
  "person/answer": "coordinator.stage.answer",
  "person/review": "coordinator.stage.review",
  "person/blocked": "coordinator.stage.blocked",
  "person/failed": "coordinator.status.failed",
};

/** 成员节点头部的阶段徽标；不在要人处理的阶段就不画。 */
export function WorkItemStageBadge({ nodeId }: { nodeId: string }) {
  const t = useT();
  const stage = useWorkItemStages((state) => state.stages[nodeId]);
  const label = stage === undefined ? undefined : LABEL[stage];
  if (label === undefined) return null;
  return (
    <Badge
      variant={
        stage === "person/failed" || stage === "person/delivery"
          ? "destructive"
          : "warn"
      }
      size="sm"
      data-slot="work-item-stage"
      data-stage={stage}
    >
      {t(label)}
    </Badge>
  );
}
