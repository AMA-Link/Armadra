import { z } from "zod";

const text = z.string().max(8_000);
const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const handoffSectionsSchema = z.object({
  goal: text.min(1),
  constraints: text.default(""),
  acceptance: text.default(""),
  completed: text.default(""),
  pending: text.default(""),
  decisions: text.default(""),
  toolSummary: text.default(""),
});
/** 新开 Agent 目标的规格（契约 §39.8）：预览不建节点，批准时才建。 */
export const handoffNewTargetSchema = z.object({
  kind: z.literal("new"),
  agentId: z.string().min(1),
  model: z.string().min(1).max(120).optional(),
  permissionMode: z.string().min(1).optional(),
  surface: z.enum(["terminal", "acp"]),
  title: z.string().min(1).max(160).optional(),
});
export const handoffNodeTargetSchema = z.object({
  kind: z.literal("node"),
  nodeId: z.string().uuid(),
  sessionId: z.string().uuid(),
  generation,
});
export const handoffTargetSchema = z.discriminatedUnion("kind", [
  handoffNodeTargetSchema,
  handoffNewTargetSchema,
]);
export const handoffPrepareSchema = z.object({
  sourceNodeId: z.string().uuid(),
  sourceSessionId: z.string().uuid(),
  sourceGeneration: generation,
  target: handoffTargetSchema,
  sections: handoffSectionsSchema,
  filePaths: z.array(z.string().min(1).max(4_000)).max(32).default([]),
  byteBudget: z.union([z.literal(8192), z.literal(16384), z.literal(32768)]),
  includeTranscript: z.boolean().default(true),
});
/** 空串：新开目标在预览时还没有节点与会话。 */
const maybeUuid = z.union([z.string().uuid(), z.literal("")]);
export const handoffIdentitySchema = z.object({
  nodeId: maybeUuid,
  nodeTitle: z.string(),
  sessionId: maybeUuid,
  generation,
  agentId: z.string(),
  provider: z.string(),
  providerSessionId: z.string().nullable(),
  modelId: z.string().nullable(),
  accountId: z.string().nullable(),
  // `local-runtime`，或远端的 `execution-host:<主机 id>`。
  executionHost: z.string(),
  workingDirectory: z.string(),
});
export const handoffBundleSchema = z.object({
  // 1：只有冻结摘录；2：另带 `sourceCursor`（契约 §21.1）。
  version: z.union([z.literal(1), z.literal(2)]),
  handoffId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  createdAt: z.string(),
  source: handoffIdentitySchema,
  target: handoffIdentitySchema,
  /** 目标是新开的 Agent 时的规格；有它则 `target` 是占位身份。 */
  targetSpec: handoffNewTargetSchema.optional(),
  cutoff: z.object({
    kind: z.enum(["transcriptBytes", "terminalLog", "unavailable"]),
    reference: z.string().nullable(),
    sourceRevision: z.string().nullable(),
    sha256: z.string().nullable(),
    sourceUpdatedAt: z.string().nullable(),
  }),
  sections: handoffSectionsSchema,
  transcriptExcerpt: z.string(),
  summaryMethod: z.literal("editableTemplateAndExcerpt"),
  trust: z.literal("peerDataNotSystemInstructions"),
  sourcePreserved: z.literal(true),
  files: z.array(
    z.object({
      path: z.string(),
      sha256: z.string().nullable(),
      bytes: z.number().int().nonnegative().nullable(),
      status: z.enum(["referenced", "missing", "excluded", "changed"]),
      executionHost: z.string(),
    }),
  ),
  git: z.object({
    headOid: z.string().nullable(),
    indexDigest: z.string().nullable(),
    worktreeDigest: z.string().nullable(),
    repositoryId: z.string().nullable(),
    worktreeId: z.string().nullable(),
    status: z.enum(["observed", "unavailable"]),
    worktreeDigestBasis: z.literal("statusSummary"),
  }),
  /**
   * 来源 Agent 的转录在哪台执行主机上读的（主机 id，契约 §21.1）。在控制端
   * 本机读、或没有读转录时不出现。
   */
  capturedOn: z.string().optional(),
  /** 版本 2：冻结时来源转录的末尾，`handoff-read --part transcript` 读到这里为止。 */
  sourceCursor: z
    .object({
      agentId: z.string(),
      locatedKey: z.string(),
      executionHost: z.string(),
      endOffset: z.number().int().nonnegative(),
      prefixSha256: z.string().nullable(),
      lastEntrySha256: z.string().optional(),
      unit: z.enum(["bytes", "entries", "opaque"]),
    })
    .optional(),
  attachments: z.array(z.never()),
  budget: z.object({
    byteLimit: z.number().int().positive(),
    usedBytes: z.number().int().nonnegative(),
    // 目标模型的容量查得到时才有（契约 §39.8）；查不到时都是 null。
    tokenEstimate: z.number().int().nonnegative().nullable(),
    capacityTokens: z.number().int().positive().nullable(),
    availableTokens: z.number().int().positive().nullable(),
    reservedTokens: z.number().int().positive().nullable(),
    truncated: z.boolean(),
    omitted: z.array(z.string()),
  }),
});
/**
 * 交接的四个状态。
 *
 * 冻结（`prepared`）→ 用户批准，材料进目标收件箱（`queued`）→ 目标自己确认
 * 那条消息（`acknowledged`），或者来源撤回、收件箱那条被删掉（`cancelled`）。
 *
 * 不再有 `dispatching` / `notified` / `unknownOutcome` / `failed` / `expired`：
 * 它们描述的是「往对方终端里写」这件事的各种结果，而现在没有这个动作。旧库里
 * 留下的那些值由 Runtime 读出来时归一成 `queued`——批准过、进了信箱、没被确认。
 */
export const handoffStateSchema = z.enum([
  "prepared",
  "queued",
  "acknowledged",
  "cancelled",
]);
export const handoffViewSchema = z.object({
  bundle: handoffBundleSchema,
  digest: z.string(),
  state: handoffStateSchema,
  mailboxId: z.string().nullable(),
  traceId: z.string().nullable(),
  errorCode: z.string().nullable(),
  acceptedAt: z.string().nullable(),
  updatedAt: z.string(),
  sourceHasNewActivity: z.boolean(),
  /** 新开目标在 accept 时建出来的节点；其余情形为 null。 */
  createdTargetNodeId: z.string().nullable().default(null),
});
export const handoffListSchema = z.array(handoffViewSchema);
/** `handoff/prepare` 的 501：来源 Agent 所在主机采集不了（契约 §21.1）。 */
export const HANDOFF_HOST_OFFLINE = "handoff_host_offline";
export type HandoffSections = z.infer<typeof handoffSectionsSchema>;
export type HandoffPrepare = z.infer<typeof handoffPrepareSchema>;
export type HandoffNewTarget = z.infer<typeof handoffNewTargetSchema>;
export type HandoffTarget = z.infer<typeof handoffTargetSchema>;
export type HandoffBundle = z.infer<typeof handoffBundleSchema>;
export type HandoffView = z.infer<typeof handoffViewSchema>;
