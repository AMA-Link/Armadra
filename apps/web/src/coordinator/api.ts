import { activeSource, srcPrefix } from "../sources/scope";
import { z } from "zod";
import { WORK_ITEM_STAGES, WORK_REPORT_STATES } from "@armadra/shared";

import { clientFor } from "@/api/client";

/**
 * 分派抽屉的调用面（契约 §15.7、§43.3）：协调者在这块画板上分派出去的任务，与失败行
 * 的「重试」，经 `coordinator.*` procedure。正文（任务提示词、成员的结果）不在
 * 答复里。
 */

export const TASK_STATUSES = ["running", "done", "failed", "stopped"] as const;

export const dispatchTaskSchema = z.object({
  taskId: z.string(),
  coordinatorNodeId: z.string(),
  runnerId: z.string(),
  nodeId: z.string(),
  status: z.enum(TASK_STATUSES),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  reason: z.string().nullable().default(null),
  retryable: z.boolean().default(false),
  // 工作项账本（#682，§15.8）：旧 core 不答，缺省为空。
  title: z.string().nullable().default(null),
  stage: z.enum(WORK_ITEM_STAGES).optional(),
  report: z
    .object({
      state: z.enum(WORK_REPORT_STATES),
      summary: z.string(),
      at: z.string(),
    })
    .nullable()
    .default(null),
  attention: z.string().nullable().default(null),
});

export type DispatchTask = z.infer<typeof dispatchTaskSchema>;

const tasksSchema = z.object({ tasks: z.array(dispatchTaskSchema) });
const taskSchema = z.object({ task: dispatchTaskSchema });

export const coordinatorKeys = {
  /** 挂在 `workflow` 之下：`workflow.*` 帧整组重读时它跟着重读。 */
  tasks: (boardId: string) =>
    [...srcPrefix(), "workflow", "tasks", boardId] as const,
};

export const coordinatorApi = {
  // 发往此刻的源（事件派发中是事件所属的源），与查询键的源前缀一致。
  tasks: async (boardId: string, source = activeSource()) =>
    tasksSchema.parse(await clientFor(source).coordinator.tasks({ boardId }))
      .tasks,
  retry: async (taskId: string, source = activeSource()) =>
    taskSchema.parse(await clientFor(source).coordinator.retry({ taskId }))
      .task,
};
