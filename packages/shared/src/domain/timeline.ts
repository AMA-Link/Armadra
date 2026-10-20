import { z } from "zod";

/**
 * 会话时间线的数据模型（设计 docs/armadra/plans/acp-progressive-view.md §2）。
 *
 * 时间线以会话行 id 为键，由 core 唯一写入；条目有确定性的 id，每次变更有一个
 * 在同一时间线内单调递增的 `seq`。页面、手机与远端设备只读：先要快照，再吃
 * 「序号之后的增量」。重复、乱序与丢帧的收敛规则在 `timeline-reduce.ts`。
 *
 * 这里只有形状（zod schema 与类型），没有行为。
 */

/** 条目从哪来；`replay` 是第一次接管旧会话时 `session/load` 回放写入的。 */
export const TIMELINE_SOURCES = [
  "acp",
  "transcript",
  "hook",
  "core",
  "replay",
] as const;
export const timelineSourceSchema = z.enum(TIMELINE_SOURCES);
export type TimelineSource = (typeof TIMELINE_SOURCES)[number];

/** 单个 id 的长度上限：`tool:<toolCallId>` 里的 CLI 侧 id 不受我们控制。 */
const ID_MAX = 300;
const idSchema = z.string().min(1).max(ID_MAX);
const countSchema = z.number().int().nonnegative();
/** 毫秒时间戳。 */
const epochMsSchema = z.number().int().nonnegative();

/* -------------------------------- 部件 -------------------------------- */

/** 图片与音频落成 blob（设计 §3.2）；条目里只带 `blobId`，超限的记 `dropped`。 */
const blobRefShape = {
  blobId: z.string().min(1).max(128).optional(),
  mimeType: z.string().max(200),
  bytes: countSchema.optional(),
  dropped: z.literal(true).optional(),
} as const;

/** 助手消息的一个部件。 */
export const timelinePartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image"), ...blobRefShape }),
  z.object({
    type: z.literal("resource_link"),
    uri: z.string().max(4_000),
    name: z.string().max(500),
    mimeType: z.string().max(200).optional(),
    title: z.string().max(500).optional(),
  }),
  z.object({
    type: z.literal("resource"),
    uri: z.string().max(4_000),
    name: z.string().max(500).optional(),
    mimeType: z.string().max(200).optional(),
    /** 内嵌的文本；只有 blob 的资源没有它，改走 `blobId`。 */
    text: z.string().optional(),
    blobId: z.string().min(1).max(128).optional(),
    bytes: countSchema.optional(),
    dropped: z.literal(true).optional(),
  }),
  z.object({ type: z.literal("audio"), ...blobRefShape }),
]);
export type TimelinePart = z.infer<typeof timelinePartSchema>;

/** 用户消息的附件：只记引用，不带正文。 */
export const timelineAttachmentSchema = z.object({
  kind: z.enum(["image", "file"]),
  name: z.string().max(500).optional(),
  mimeType: z.string().max(200).optional(),
  blobId: z.string().min(1).max(128).optional(),
  uri: z.string().max(4_000).optional(),
  bytes: countSchema.optional(),
});
export type TimelineAttachment = z.infer<typeof timelineAttachmentSchema>;

/* ------------------------------ 工具调用 ------------------------------ */

/** ACP 的十种工具 kind，加上我们自己的 `subagent`。 */
export const TIMELINE_TOOL_KINDS = [
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
  "subagent",
] as const;
export const timelineToolKindSchema = z.enum(TIMELINE_TOOL_KINDS);
export type TimelineToolKind = (typeof TIMELINE_TOOL_KINDS)[number];

export const TIMELINE_TOOL_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
] as const;
export const timelineToolStatusSchema = z.enum(TIMELINE_TOOL_STATUSES);
export type TimelineToolStatus = (typeof TIMELINE_TOOL_STATUSES)[number];

/** 输出文本只留尾部：`truncated` 带原长度（设计 §3.2）。 */
const clippedShape = {
  truncated: z.literal(true).optional(),
  originalBytes: countSchema.optional(),
} as const;

export const timelineToolContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string(), ...clippedShape }),
  z.object({
    type: z.literal("diff"),
    path: z.string().max(4_000),
    oldText: z.string().nullish(),
    newText: z.string().optional(),
    /** diff 超过上限时只记行数，不带正文。 */
    truncated: z.literal(true).optional(),
    addedLines: countSchema.optional(),
    removedLines: countSchema.optional(),
  }),
  z.object({
    type: z.literal("terminal"),
    terminalId: z.string().max(200),
    command: z.string().max(10_000).optional(),
    output: z.string().optional(),
    exitCode: z.number().int().nullish(),
    ...clippedShape,
  }),
  z.object({ type: z.literal("image"), ...blobRefShape }),
  z.object({
    type: z.literal("resource"),
    uri: z.string().max(4_000),
    name: z.string().max(500).optional(),
    mimeType: z.string().max(200).optional(),
    text: z.string().optional(),
    blobId: z.string().min(1).max(128).optional(),
    bytes: countSchema.optional(),
    dropped: z.literal(true).optional(),
    ...clippedShape,
  }),
]);
export type TimelineToolContent = z.infer<typeof timelineToolContentSchema>;

export const timelineToolLocationSchema = z.object({
  path: z.string().max(4_000),
  line: z.number().int().nullish(),
});
export type TimelineToolLocation = z.infer<typeof timelineToolLocationSchema>;

/**
 * 工具入参的结构化摘要（设计 §3.2）：按 kind 取出命令、路径、查询、URL，其余
 * 标量折成键值列表。页面不再贴 JSON 原文。
 */
export const timelineToolInputSchema = z.object({
  command: z.string().max(10_000).optional(),
  path: z.string().max(4_000).optional(),
  line: z.number().int().optional(),
  query: z.string().max(2_000).optional(),
  url: z.string().max(4_000).optional(),
  fields: z
    .array(z.object({ key: z.string().max(100), value: z.string().max(400) }))
    .max(12)
    .optional(),
});
export type TimelineToolInput = z.infer<typeof timelineToolInputSchema>;

/* -------------------------------- 条目 -------------------------------- */

/**
 * 每个条目的公共字段。`rev` 等于最后一次修改它的 `seq`；`gen` 是驱动代次
 * （同一行上驱动切换不换行 id，所以切换前后共用一条时间线）。
 */
const itemBase = {
  id: idSchema,
  turn: countSchema,
  ord: countSchema,
  rev: countSchema,
  source: timelineSourceSchema,
  at: epochMsSchema,
  gen: countSchema,
} as const;

export const timelineUserItemSchema = z.object({
  ...itemBase,
  kind: z.literal("user"),
  text: z.string(),
  attachments: z.array(timelineAttachmentSchema).optional(),
  author: z.string().max(200).optional(),
  clientTurnId: z.string().max(128).optional(),
});

export const timelineAssistantItemSchema = z.object({
  ...itemBase,
  kind: z.literal("assistant"),
  parts: z.array(timelinePartSchema),
  streaming: z.boolean(),
});

export const timelineThoughtItemSchema = z.object({
  ...itemBase,
  kind: z.literal("thought"),
  text: z.string(),
  streaming: z.boolean(),
  durationMs: countSchema.optional(),
});

/** 审批的结局记在工具上：关联审批的 `pendingId` 与答复。 */
export const timelineToolPermissionSchema = z.object({
  pendingId: z.string().max(200),
  outcome: z.enum(["pending", "allowed", "denied", "cancelled"]),
  optionId: z.string().max(200).optional(),
});

export const timelineToolItemSchema = z.object({
  ...itemBase,
  kind: z.literal("tool"),
  toolCallId: z.string().min(1).max(200),
  toolKind: timelineToolKindSchema,
  title: z.string().max(2_000),
  status: timelineToolStatusSchema,
  locations: z.array(timelineToolLocationSchema),
  input: timelineToolInputSchema.optional(),
  content: z.array(timelineToolContentSchema),
  permission: timelineToolPermissionSchema.optional(),
  /** 子代理内部的调用挂在它下面（渲染层嵌套显示）。 */
  parentToolCallId: z.string().max(200).optional(),
  startedAt: epochMsSchema,
  endedAt: epochMsSchema.optional(),
});

export const timelinePlanEntrySchema = z.object({
  content: z.string(),
  status: z.string().max(40).optional(),
  priority: z.string().max(40).optional(),
});
export type TimelinePlanEntry = z.infer<typeof timelinePlanEntrySchema>;

export const timelinePlanItemSchema = z.object({
  ...itemBase,
  kind: z.literal("plan"),
  entries: z.array(timelinePlanEntrySchema),
});

export const timelineApprovalOptionSchema = z.object({
  optionId: z.string().max(200),
  name: z.string().max(500),
  kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]),
});
export type TimelineApprovalOption = z.infer<
  typeof timelineApprovalOptionSchema
>;

export const TIMELINE_PENDING_STATES = [
  "pending",
  "answered",
  "cancelled",
] as const;
export const timelinePendingStateSchema = z.enum(TIMELINE_PENDING_STATES);
export type TimelinePendingState = (typeof TIMELINE_PENDING_STATES)[number];

export const timelineApprovalItemSchema = z.object({
  ...itemBase,
  kind: z.literal("approval"),
  pendingId: z.string().max(200),
  protocol: z.string().max(40),
  toolCallId: z.string().max(200).optional(),
  options: z.array(timelineApprovalOptionSchema),
  state: timelinePendingStateSchema,
  answer: z.object({ optionId: z.string().max(200).optional() }).optional(),
  answeredBy: z.string().max(200).optional(),
});

export const timelineElicitationItemSchema = z.object({
  ...itemBase,
  kind: z.literal("elicitation"),
  pendingId: z.string().max(200),
  message: z.string(),
  mode: z.enum(["form", "url"]),
  /** 表单 schema 原样（JSON 文本），页面按已有的 `ElicitationCard` 解析。 */
  requestedSchema: z.string().optional(),
  url: z.string().max(4_000).optional(),
  state: timelinePendingStateSchema,
  answer: z
    .object({
      action: z.enum(["accept", "decline", "cancel"]),
    })
    .optional(),
  answeredBy: z.string().max(200).optional(),
});

export const TIMELINE_NOTICE_CODES = [
  "mode_changed",
  "model_changed",
  "compacted",
  "retry",
  "driver_switched",
  "resumed",
  "not_resumed",
  "hibernated",
  "woke",
  "exited",
  "error",
] as const;
export const timelineNoticeCodeSchema = z.enum(TIMELINE_NOTICE_CODES);
export type TimelineNoticeCode = (typeof TIMELINE_NOTICE_CODES)[number];

export const timelineNoticeParamsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

export const timelineNoticeItemSchema = z.object({
  ...itemBase,
  kind: z.literal("notice"),
  code: timelineNoticeCodeSchema,
  params: timelineNoticeParamsSchema,
});

export const timelineTurnErrorSchema = z.object({
  code: z.string().max(200),
  message: z.string().max(4_000),
});

export const timelineTurnUsageSchema = z.object({
  used: countSchema,
  size: countSchema,
});

export const timelineTurnItemSchema = z.object({
  ...itemBase,
  kind: z.literal("turn"),
  turnId: z.string().min(1).max(200),
  startedAt: epochMsSchema,
  endedAt: epochMsSchema.optional(),
  stopReason: z.string().max(40).optional(),
  error: timelineTurnErrorSchema.optional(),
  /** 回合里等审批花掉的毫秒数（「已用时」要扣掉它）。 */
  permissionWaitMs: countSchema,
  usage: timelineTurnUsageSchema.optional(),
});

export const TIMELINE_ITEM_KINDS = [
  "user",
  "assistant",
  "thought",
  "tool",
  "plan",
  "approval",
  "elicitation",
  "notice",
  "turn",
] as const;

export const timelineItemSchema = z.discriminatedUnion("kind", [
  timelineUserItemSchema,
  timelineAssistantItemSchema,
  timelineThoughtItemSchema,
  timelineToolItemSchema,
  timelinePlanItemSchema,
  timelineApprovalItemSchema,
  timelineElicitationItemSchema,
  timelineNoticeItemSchema,
  timelineTurnItemSchema,
]);

export type TimelineItem = z.infer<typeof timelineItemSchema>;
export type TimelineItemKind = TimelineItem["kind"];
export type TimelineUserItem = z.infer<typeof timelineUserItemSchema>;
export type TimelineAssistantItem = z.infer<typeof timelineAssistantItemSchema>;
export type TimelineThoughtItem = z.infer<typeof timelineThoughtItemSchema>;
export type TimelineToolItem = z.infer<typeof timelineToolItemSchema>;
export type TimelinePlanItem = z.infer<typeof timelinePlanItemSchema>;
export type TimelineApprovalItem = z.infer<typeof timelineApprovalItemSchema>;
export type TimelineElicitationItem = z.infer<
  typeof timelineElicitationItemSchema
>;
export type TimelineNoticeItem = z.infer<typeof timelineNoticeItemSchema>;
export type TimelineTurnItem = z.infer<typeof timelineTurnItemSchema>;

/** 墓碑：条目被删（节点清空、回合被丢弃）后留下的记录，让增量同步能把删除传出去。 */
export const timelineTombstoneSchema = z.object({
  id: idSchema,
  rev: countSchema,
  deleted: z.literal(true),
});
export type TimelineTombstone = z.infer<typeof timelineTombstoneSchema>;

/** 同步返回的一项：完整值或墓碑。 */
export const timelineItemRecordSchema = z.union([
  timelineTombstoneSchema,
  timelineItemSchema,
]);
export type TimelineItemRecord = z.infer<typeof timelineItemRecordSchema>;

/* ------------------------------- 头部值 ------------------------------- */

/**
 * 会话级的值，不是条目：用量、斜杠命令、模式、模型目录、标题。与条目共用
 * `seq`，所以随增量下发，也随快照恢复，core 重启后不再丢。
 */
export const timelineHeadSchema = z.object({
  usage: z
    .object({
      used: countSchema,
      size: countSchema,
      cost: z
        .object({ amount: z.number(), currency: z.string().max(16) })
        .optional(),
    })
    .nullable()
    .optional(),
  commands: z
    .array(
      z.object({
        name: z.string().max(200),
        description: z.string().max(2_000),
      }),
    )
    .optional(),
  modes: z
    .object({
      currentModeId: z.string().max(200),
      availableModes: z.array(
        z.object({
          id: z.string().max(200),
          name: z.string().max(500),
          description: z.string().max(2_000).nullish(),
        }),
      ),
    })
    .nullable()
    .optional(),
  models: z
    .object({
      currentModelId: z.string().max(200),
      availableModels: z.array(
        z.object({
          modelId: z.string().max(200),
          name: z.string().max(500),
          description: z.string().max(2_000).nullish(),
        }),
      ),
    })
    .nullable()
    .optional(),
  title: z.string().max(1_000).nullable().optional(),
});
export type TimelineHead = z.infer<typeof timelineHeadSchema>;

/* -------------------------------- 操作 -------------------------------- */

/**
 * 一次变更。`seq` 在同一时间线内严格递增；`put` 带完整新值（落库的就是它），
 * `append` 只带流式文本的增量（省带宽），`head` 合并头部值（字段值 `null` 清掉）。
 */
export const timelineOpSchema = z.discriminatedUnion("op", [
  z.object({
    seq: z.number().int().positive(),
    op: z.literal("put"),
    item: timelineItemSchema,
  }),
  z.object({
    seq: z.number().int().positive(),
    op: z.literal("append"),
    itemId: idSchema,
    delta: z.object({
      text: z.string(),
      /** 助手消息的第几个部件；缺省是最后一个文本部件。其他条目忽略。 */
      part: countSchema.optional(),
    }),
  }),
  z.object({
    seq: z.number().int().positive(),
    op: z.literal("remove"),
    itemId: idSchema,
  }),
  z.object({
    seq: z.number().int().positive(),
    op: z.literal("head"),
    head: timelineHeadSchema,
  }),
]);
export type TimelineOp = z.infer<typeof timelineOpSchema>;
export type TimelinePutOp = Extract<TimelineOp, { op: "put" }>;
export type TimelineAppendOp = Extract<TimelineOp, { op: "append" }>;

/** `timeline.delta` 事件：`from` 是上一次的 `head_seq`，`to` 是这一帧之后的。 */
export const timelineDeltaSchema = z.object({
  timelineId: z.string().min(1),
  nodeId: z.string().min(1),
  from: countSchema,
  to: countSchema,
  ops: z.array(timelineOpSchema),
});
export type TimelineDelta = z.infer<typeof timelineDeltaSchema>;

/* ------------------------------- 活动层 ------------------------------- */

/** 渐进式状态（设计 §2.4）；粗状态 `agent_status.state` 不改。 */
export const ACTIVITY_PHASES = [
  "starting",
  "restoring",
  "idle",
  "submitting",
  "thinking",
  "tool",
  "awaiting_approval",
  "awaiting_input",
  "responding",
  "switching",
  "sleeping",
  "exited",
] as const;
export const activityPhaseSchema = z.enum(ACTIVITY_PHASES);
export type ActivityPhase = (typeof ACTIVITY_PHASES)[number];

export const ACTIVITY_OUTCOME_KINDS = [
  "done",
  "cancelled",
  "failed",
  "refused",
  "limit",
] as const;

export const sessionActivitySchema = z.object({
  phase: activityPhaseSchema,
  detail: z
    .object({
      /** 工具标题、正在做的事。 */
      label: z.string().max(2_000).optional(),
      toolKind: z.string().max(40).optional(),
      /** 并发的工具数，或已回放的条数。 */
      count: countSchema.optional(),
      /** 启动阶段：spawn / initialize / session / configure。 */
      step: z.string().max(40).optional(),
    })
    .optional(),
  /** 进入本阶段的时间（毫秒）。 */
  since: epochMsSchema,
  turnId: z.string().max(200).optional(),
  turnStartedAt: epochMsSchema.optional(),
  lastOutcome: z
    .object({
      kind: z.enum(ACTIVITY_OUTCOME_KINDS),
      at: epochMsSchema,
      error: z.string().max(4_000).optional(),
    })
    .optional(),
  /** 最近一次可见输出的时间，用于「已 N 秒无输出」。 */
  lastOutputAt: epochMsSchema.optional(),
  /** `${bootId}:${n}`；比较先比 bootId 再比 n（见 `compareActivityRev`）。 */
  rev: z.string().min(3).max(100),
});
export type SessionActivity = z.infer<typeof sessionActivitySchema>;
export type ActivityOutcomeKind = (typeof ACTIVITY_OUTCOME_KINDS)[number];

/** `timeline.activity` 事件。 */
export const timelineActivityEventSchema = z.object({
  timelineId: z.string().min(1),
  nodeId: z.string().min(1),
  activity: sessionActivitySchema,
});
export type TimelineActivityEvent = z.infer<typeof timelineActivityEventSchema>;

/**
 * 两个活动版本哪个新：`bootId` 不同就认为不可比（core 重启过）并返回 `null`，
 * 由调用方取后到的那个；同一个 `bootId` 比 `n`。
 */
export function compareActivityRev(a: string, b: string): number | null {
  const [bootA, countA] = splitRev(a);
  const [bootB, countB] = splitRev(b);
  if (bootA !== bootB) return null;
  return countA - countB;
}

function splitRev(rev: string): [string, number] {
  const cut = rev.lastIndexOf(":");
  if (cut < 0) return [rev, 0];
  const count = Number(rev.slice(cut + 1));
  return [rev.slice(0, cut), Number.isFinite(count) ? count : 0];
}

/* ------------------------- 回合索引、快照与分页 ------------------------- */

/** 回合索引的一项：滚动分页时不必取整回合就能画占位。 */
export const turnIndexSchema = z.object({
  turnId: z.string().max(200),
  turn: countSchema,
  startedAt: epochMsSchema,
  endedAt: epochMsSchema.optional(),
  /** 回合第一句用户消息的前 80 字。 */
  headText: z.string().max(80),
  counts: z.object({
    items: countSchema,
    tools: countSchema,
    thoughts: countSchema,
    messages: countSchema,
  }),
});
export type TurnIndex = z.infer<typeof turnIndexSchema>;

/** `timeline.open` 的答：尾部几个回合 + 回合索引 + 头部值 + 活动。 */
export const timelineSnapshotSchema = z.object({
  headSeq: countSchema,
  head: timelineHeadSchema,
  /** 头部值最后一次修改的 `seq`。 */
  headRev: countSchema,
  turns: z.array(turnIndexSchema),
  items: z.array(timelineItemSchema),
  activity: sessionActivitySchema.optional(),
});
export type TimelineSnapshot = z.infer<typeof timelineSnapshotSchema>;

/** `timeline.sync` 的答：`rev > after` 的全部条目（含墓碑）；头部值变了才带。 */
export const timelineSyncResultSchema = z.object({
  headSeq: countSchema,
  head: timelineHeadSchema.optional(),
  headRev: countSchema.optional(),
  items: z.array(timelineItemRecordSchema),
});
export type TimelineSyncResult = z.infer<typeof timelineSyncResultSchema>;

/** `timeline.page` 的答：更早回合的完整条目。 */
export const timelinePageResultSchema = z.object({
  items: z.array(timelineItemSchema),
});
export type TimelinePageResult = z.infer<typeof timelinePageResultSchema>;
