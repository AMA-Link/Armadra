import { activeSource, srcPrefix } from "../sources/scope";
import { z } from "zod";
import {
  WORK_ITEM_STAGES,
  workItemAttentionSchema,
  workItemReplySchema,
  workItemReportSchema,
} from "@armadra/shared";

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
  // 工作项账本（契约 §90）：旧 core 没有这些字段。
  title: z.string().nullable().default(null),
  // 将来的 core 多一个阶段值时，旧页面当作没有阶段，而不是整张列表解析失败。
  stage: z.enum(WORK_ITEM_STAGES).nullable().default(null).catch(null),
  report: workItemReportSchema.nullable().default(null),
  attention: workItemAttentionSchema.nullable().default(null),
  // 绑定的 PR（契约 §103.1）：旧 core 没有这个字段。
  pulls: z
    .array(
      z.object({
        repo: z.string(),
        number: z.number(),
        own: z.boolean(),
        url: z.string(),
      }),
    )
    .default([])
    .catch([]),
  // 协调者经 `canvas notify` 说的最新一句话（契约 §101）：旧 core 没有这个字段。
  reply: workItemReplySchema.nullable().default(null).catch(null),
});

export type DispatchTask = z.infer<typeof dispatchTaskSchema>;

const tasksSchema = z.object({ tasks: z.array(dispatchTaskSchema) });
const taskSchema = z.object({ task: dispatchTaskSchema });
const readSchema = z.object({ read: z.number() });

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
  /** 打开抽屉：这块画板上协调者的回复标为已读（契约 §101.2）。 */
  readReplies: async (boardId: string, source = activeSource()) =>
    readSchema.parse(
      await clientFor(source).coordinator.readReplies({ boardId }),
    ).read,
  retry: async (taskId: string, source = activeSource()) =>
    taskSchema.parse(await clientFor(source).coordinator.retry({ taskId }))
      .task,
};
