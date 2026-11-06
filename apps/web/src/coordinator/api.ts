import { activeSource, srcPrefix } from "../sources/scope";
import { z } from "zod";
import {
  WORK_ITEM_STAGES,
  workItemAttentionSchema,
  workItemReplySchema,
  workItemReportSchema,
} from "@armadra/shared";

import { clientFor, errorCode } from "@/api/client";

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

/* ----------------------- 来源与候选（契约 §104.7） ----------------------- */

export const SOURCE_KINDS = ["issue", "pull"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const SOURCE_MODES = ["observe", "auto"] as const;
export type SourceMode = (typeof SOURCE_MODES)[number];
export const REVIEWS = ["agree", "disagree"] as const;
export type Review = (typeof REVIEWS)[number];
/** 候选一页的条数。 */
export const INTAKE_PAGE_SIZE = 20;

const NO_STATS = {
  decided: 0,
  accepted: 0,
  agreed: 0,
  disagreed: 0,
  window: 20,
};

export const intakeSourceSchema = z.object({
  id: z.string(),
  coordinatorNodeId: z.string(),
  repo: z.string(),
  // 更新的 core 多出来的种类与模式：丢掉 / 当作观察，不让整张列表解析失败。
  kinds: z
    .array(z.string())
    .transform((list) =>
      list.filter((kind): kind is SourceKind =>
        (SOURCE_KINDS as readonly string[]).includes(kind),
      ),
    ),
  mode: z.enum(SOURCE_MODES).catch("observe"),
  allow: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  rulesHash: z.string().default(""),
  rulesCurrentHash: z.string().default(""),
  rulesPresent: z.boolean().default(false),
  stats: z
    .object({
      decided: z.number(),
      accepted: z.number(),
      agreed: z.number(),
      disagreed: z.number(),
      window: z.number(),
    })
    .default(NO_STATS)
    .catch(NO_STATS),
});

export type IntakeSource = z.infer<typeof intakeSourceSchema>;

export const intakeCandidateSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  kind: z.enum(SOURCE_KINDS).catch("issue"),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  author: z.string().nullable().default(null),
  url: z.string().default(""),
  authorized: z.boolean().default(false),
  seenAt: z.string(),
  verdict: z.enum(["accept", "skip"]).nullable().default(null).catch(null),
  reason: z.string().nullable().default(null),
  verdictAt: z.string().nullable().default(null),
  modeAtVerdict: z.enum(SOURCE_MODES).nullable().default(null).catch(null),
  review: z.enum(REVIEWS).nullable().default(null).catch(null),
  itemId: z.string().nullable().default(null),
  outcome: z.string().nullable().default(null),
});

export type IntakeCandidate = z.infer<typeof intakeCandidateSchema>;

const sourcesSchema = z.object({ sources: z.array(intakeSourceSchema) });
const sourceSchema = z.object({ source: intakeSourceSchema });
const intakeSchema = z.object({
  candidates: z.array(intakeCandidateSchema),
  total: z.number(),
  next: z.number().nullable().default(null),
});
const candidateSchema = z.object({ candidate: intakeCandidateSchema });
const deletedSchema = z.object({ deleted: z.boolean() });

export interface IntakePage {
  readonly candidates: IntakeCandidate[];
  readonly total: number;
  readonly next: number | null;
}

export interface SaveSourceInput {
  readonly id?: string;
  readonly coordinatorNodeId: string;
  /** 网页地址或 `<主机>/<owner>/<名字>`。 */
  readonly repo: string;
  readonly kinds: readonly SourceKind[];
  readonly mode: SourceMode;
  readonly allow: readonly string[];
  readonly enabled: boolean;
  readonly confirmRules?: boolean;
}

/** 旧 core 没有这几条 procedure：答 `not_found`，当作没有来源与候选。 */
async function orEmpty<T>(call: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (errorCode(error) === "not_found") return empty;
    throw error;
  }
}

export const coordinatorKeys = {
  /** 挂在 `workflow` 之下：`workflow.*` 帧整组重读时它跟着重读。 */
  tasks: (boardId: string) =>
    [...srcPrefix(), "workflow", "tasks", boardId] as const,
  /** 来源与候选与 `tasks` 同前缀；`workflow.intake` 帧重读这两组。 */
  sources: (boardId: string) =>
    [...srcPrefix(), "workflow", "sources", boardId] as const,
  intake: (boardId: string, decided: boolean, page: number) =>
    [...srcPrefix(), "workflow", "intake", boardId, decided, page] as const,
  /** 候选的整组（任意过滤与页码）。 */
  intakeAll: (boardId: string) =>
    [...srcPrefix(), "workflow", "intake", boardId] as const,
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
  sources: async (boardId: string, source = activeSource()) =>
    (
      await orEmpty(
        async () =>
          sourcesSchema.parse(
            await clientFor(source).coordinator.sources({ boardId }),
          ),
        { sources: [] as IntakeSource[] },
      )
    ).sources,
  saveSource: async (input: SaveSourceInput, source = activeSource()) =>
    sourceSchema.parse(
      await clientFor(source).coordinator.saveSource({
        ...input,
        kinds: [...input.kinds],
        allow: [...input.allow],
      }),
    ).source,
  deleteSource: async (id: string, source = activeSource()) =>
    deletedSchema.parse(
      await clientFor(source).coordinator.deleteSource({ id }),
    ).deleted,
  intake: async (
    boardId: string,
    page: { decided: boolean; offset: number },
    source = activeSource(),
  ): Promise<IntakePage> =>
    orEmpty(
      async () =>
        intakeSchema.parse(
          await clientFor(source).coordinator.intake({
            boardId,
            decided: page.decided,
            offset: page.offset,
            limit: INTAKE_PAGE_SIZE,
          }),
        ),
      { candidates: [], total: 0, next: null },
    ),
  reviewIntake: async (
    candidateId: string,
    review: Review | null,
    source = activeSource(),
  ) =>
    candidateSchema.parse(
      await clientFor(source).coordinator.reviewIntake({ candidateId, review }),
    ).candidate,
};
