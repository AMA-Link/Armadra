/**
 * 审批与 elicitation 卡片吃的两种视图，以及从 `agent.approval` 的载荷里认出它们。
 * （原先在会话读模型里；读模型改读时间线之后，这两样只剩卡片用。）
 */
import {
  acpElicitationRequestSchema,
  acpPermissionRequestSchema,
  type AcpElicitation,
  type AcpPermissionOption,
  type AcpToolCall,
} from "@armadra/shared";

/** 「将发生」的一条：一个文件，可带行号与 `+N −M`。 */
export interface AcpPermissionChange {
  readonly path: string;
  readonly line?: number | null | undefined;
  readonly stat?: { additions: number; deletions: number } | undefined;
}

export interface AcpPermissionView {
  readonly pendingId: string;
  readonly toolCall: AcpToolCall;
  readonly options: readonly AcpPermissionOption[];
  /**
   * 已经算好的「将发生」条目（条目里存的摘要，没有差异正文可算时用）；
   * 没有就由 `toolCall` 现算。
   */
  readonly changes?: readonly AcpPermissionChange[];
}

/** 一条挂起的 `elicitation/create`（契约 §26.1）。 */
export interface AcpElicitationView {
  readonly pendingId: string;
  readonly elicitation: AcpElicitation;
}

/**
 * `agent.approval` 的 `request` 是审批记录（`request` 字段才是 ACP 的载荷），
 * 也认直接给载荷的形状。不是 ACP 的审批回 `null`。
 */
export function acpPermissionOf(
  pendingId: string,
  request: unknown,
): AcpPermissionView | null {
  const record = request as { request?: unknown } | null;
  for (const candidate of [record?.request, request]) {
    const parsed = acpPermissionRequestSchema.safeParse(candidate);
    if (parsed.success)
      return {
        pendingId,
        toolCall: parsed.data.toolCall,
        options: parsed.data.options,
      };
  }
  return null;
}

/** `agent.approval` 里的 elicitation（形状同上）；不是就回 `null`。 */
export function acpElicitationOf(
  pendingId: string,
  request: unknown,
): AcpElicitationView | null {
  const record = request as { request?: unknown } | null;
  for (const candidate of [record?.request, request]) {
    const parsed = acpElicitationRequestSchema.safeParse(candidate);
    if (parsed.success)
      return { pendingId, elicitation: parsed.data.elicitation };
  }
  return null;
}
