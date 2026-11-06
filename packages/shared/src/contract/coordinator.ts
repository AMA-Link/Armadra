import { z } from "zod";

import {
  WORKFLOW_TASK_RUN_STATUSES,
  WORK_ITEM_STAGES,
  workItemAttentionSchema,
  workItemReplySchema,
  workItemReportSchema,
} from "../api/workflows.js";
import { errors } from "./errors.js";
import { meta, oc } from "./meta.js";

/**
 * `coordinator.*`（契约 §43.3）：分派抽屉的两条调用（§15.7）——协调者在一块画板上
 * 分派出去的任务，与失败行的「重试」。路径同属 `/api/workflows/`，实现与 `workflows.*`
 * 同在 `core/workflow/`。
 *
 * 一行只带状态、时刻与「能不能重试」，不带任务提示词与成员的结果正文（正文留在库里）。
 * 重试是再投一次任务提示词，与起跑同一档（`agent:launch`，要任务所在画布上的
 * operator）；投递仍经协作域的投递门，不替人回答权限提示。
 */

const base = { since: "1.12", contract: "§43.3" } as const;

const taskRowWire = z.object({
  taskId: z.string(),
  coordinatorNodeId: z.string(),
  runnerId: z.string(),
  nodeId: z.string(),
  status: z.enum(WORKFLOW_TASK_RUN_STATUSES),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  reason: z.string().nullable(),
  retryable: z.boolean(),
  /** 工作项账本（§90）：一行标题、由事实推出的阶段、最近报告、待决问题。 */
  title: z.string().nullable(),
  stage: z.enum(WORK_ITEM_STAGES),
  report: workItemReportSchema.nullable(),
  attention: workItemAttentionSchema.nullable(),
  /** 绑定的 PR（§103.1）：页面显示编号，点开是 `url`（可能为空）。 */
  pulls: z.array(
    z.object({
      repo: z.string(),
      number: z.number().int().positive(),
      own: z.boolean(),
      url: z.string(),
    }),
  ),
  /** 协调者经 `canvas notify` 说的最新一句话（§101.2）；没有是 null。 */
  reply: workItemReplySchema.nullable(),
});

/** 来源的种类与模式（契约 §104.1）。 */
export const INTAKE_THREAD_KINDS = ["issue", "pull"] as const;
export const INTAKE_SOURCE_MODES = ["observe", "auto"] as const;
export const INTAKE_VERDICTS = ["accept", "skip"] as const;
export const INTAKE_REVIEWS = ["agree", "disagree"] as const;

/** 一个来源最近 N 条判定里的数目（契约 §104.1、§104.2）；只给人看。 */
const sourceStatsWire = z.object({
  decided: z.number().int().nonnegative(),
  accepted: z.number().int().nonnegative(),
  agreed: z.number().int().nonnegative(),
  disagreed: z.number().int().nonnegative(),
  window: z.number().int().positive(),
});

/**
 * 一个来源（契约 §104.7）。`rulesHash` 是人确认过的哈希（没确认过是空串），
 * `rulesCurrentHash` 是此刻规则文件的哈希（缺失与远端工作区是空串）。
 */
const sourceWire = z.object({
  id: z.string(),
  coordinatorNodeId: z.string(),
  repo: z.string(),
  kinds: z.array(z.enum(INTAKE_THREAD_KINDS)),
  mode: z.enum(INTAKE_SOURCE_MODES),
  allow: z.array(z.string()),
  enabled: z.boolean(),
  rulesHash: z.string(),
  rulesCurrentHash: z.string(),
  rulesPresent: z.boolean(),
  stats: sourceStatsWire,
});

/** 一条候选（契约 §104.7）：不带正文，时刻是 RFC 3339。 */
const candidateWire = z.object({
  id: z.string(),
  sourceId: z.string(),
  kind: z.enum(INTAKE_THREAD_KINDS),
  repo: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  author: z.string().nullable(),
  url: z.string(),
  authorized: z.boolean(),
  seenAt: z.string(),
  verdict: z.enum(INTAKE_VERDICTS).nullable(),
  /** 判定理由（`verdict_reason`）。 */
  reason: z.string().nullable(),
  verdictAt: z.string().nullable(),
  modeAtVerdict: z.enum(INTAKE_SOURCE_MODES).nullable(),
  review: z.enum(INTAKE_REVIEWS).nullable(),
  itemId: z.string().nullable(),
  /** 空 / `dispatched` / `refused:<原因码>`。 */
  outcome: z.string().nullable(),
});

const intakeBase = { since: "1.55", contract: "§43.3" } as const;

export const coordinator = {
  /** 一块画板上的任务；服务器壳上必须带 `boardId`，按它查出画布。 */
  tasks: oc
    .input(z.object({ boardId: z.string().optional() }))
    .output(z.object({ tasks: z.array(taskRowWire) }))
    .errors(errors.pick("forbidden"))
    .meta(
      meta({
        ...base,
        scope: "canvas:read",
        legacy: { method: "GET", path: "/api/workflows/tasks" },
      }),
    ),
  /** 人打开分派抽屉：这块画板上协调者的回复都标为已读（§101.2）。 */
  readReplies: oc
    .input(z.object({ boardId: z.string().min(1) }))
    .output(z.object({ read: z.number().int().nonnegative() }))
    .errors(errors.pick("forbidden", "not_found"))
    .meta(
      meta({
        since: "1.54",
        contract: "§43.3",
        scope: "canvas:read",
        legacy: { method: "POST", path: "/api/workflows/tasks/read-replies" },
      }),
    ),
  /** 重试一条失败或已停的任务。 */
  retry: oc
    .input(z.object({ taskId: z.string().min(1) }))
    .output(z.object({ task: taskRowWire }))
    .errors(errors.pick("forbidden", "not_found", "conflict"))
    .meta(
      meta({
        ...base,
        scope: "agent:launch",
        legacy: { method: "POST", path: "/api/workflows/tasks/{taskId}/retry" },
      }),
    ),
  /** 一块画板上协调者的来源（契约 §104.7）。 */
  sources: oc
    .input(z.object({ boardId: z.string().min(1) }))
    .output(z.object({ sources: z.array(sourceWire) }))
    .errors(errors.pick("forbidden", "not_found"))
    .meta(
      meta({
        ...intakeBase,
        scope: "canvas:read",
        legacy: { method: "GET", path: "/api/workflows/sources" },
      }),
    ),
  /** 建或改一个来源；只有人能配，与重试同一档（`agent:launch`）。 */
  saveSource: oc
    .input(
      z.object({
        id: z.string().min(1).optional(),
        coordinatorNodeId: z.string().min(1),
        /** 网页地址或 `<主机>/<owner>/<名字>`，core 用托管平台域认并规范化。 */
        repo: z.string().min(1),
        kinds: z.array(z.enum(INTAKE_THREAD_KINDS)).min(1),
        mode: z.enum(INTAKE_SOURCE_MODES),
        allow: z.array(z.string()),
        enabled: z.boolean(),
        /** 把此刻规则文件的哈希记成人确认过的。 */
        confirmRules: z.boolean().optional(),
      }),
    )
    .output(z.object({ source: sourceWire }))
    .errors(errors.pick("bad_request", "forbidden", "not_found", "conflict"))
    .meta(
      meta({
        ...intakeBase,
        scope: "agent:launch",
        legacy: { method: "POST", path: "/api/workflows/sources" },
      }),
    ),
  /** 删一个来源；它名下的候选跟着删。 */
  deleteSource: oc
    .input(z.object({ id: z.string().min(1) }))
    .output(z.object({ deleted: z.boolean() }))
    .errors(errors.pick("forbidden"))
    .meta(
      meta({
        ...intakeBase,
        scope: "agent:launch",
        legacy: { method: "DELETE", path: "/api/workflows/sources/{id}" },
      }),
    ),
  /** 一块画板上协调者的候选；`next` 是下一页的偏移，没有更多是 null。 */
  intake: oc
    .input(
      z.object({
        boardId: z.string().min(1),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        offset: z.coerce.number().int().nonnegative().optional(),
        /** `true` 只要判定过的，`false` 只要没判定的；旧路径上是 `"true"` / `"false"`。 */
        decided: z.union([z.boolean(), z.enum(["true", "false"])]).optional(),
      }),
    )
    .output(
      z.object({
        candidates: z.array(candidateWire),
        total: z.number().int().nonnegative(),
        next: z.number().int().nonnegative().nullable(),
      }),
    )
    .errors(errors.pick("bad_request", "forbidden", "not_found"))
    .meta(
      meta({
        ...intakeBase,
        scope: "canvas:read",
        legacy: { method: "GET", path: "/api/workflows/intake" },
      }),
    ),
  /** 人对一条判定表态（同意 / 不同意），`null` 撤回；只影响这一行与统计。 */
  reviewIntake: oc
    .input(
      z.object({
        candidateId: z.string().min(1),
        review: z.enum(INTAKE_REVIEWS).nullable(),
      }),
    )
    .output(z.object({ candidate: candidateWire }))
    .errors(errors.pick("bad_request", "forbidden", "not_found", "conflict"))
    .meta(
      meta({
        ...intakeBase,
        scope: "agent:launch",
        legacy: {
          method: "POST",
          path: "/api/workflows/intake/{candidateId}/review",
        },
      }),
    ),
};
