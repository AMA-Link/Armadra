import type { AcpToolCallUpdate } from "@armadra/agent/acp";

/**
 * 以 `_` 开头的扩展请求（ACP 规范留给各家的位置）里，需要人决定的那一类。
 *
 * 目前只有 grok 的 `_x.ai/exit_plan_mode`：grok 在 plan 模式下把计划交给客户端审批，
 * 请求在人答之前一直挂着。它进审批挂起表（与 `session/request_permission` 同一张，
 * `AcpProcess.holdExt`），卡片正文是计划，选项是「批准 / 拒绝」；人的决定经适配器
 * 里**这一处**映射函数（{@link AcpExtRequestSpec.reply}）变成应答 JSON。
 *
 * 红线：绝不自动代答。没人处理（没有审批消费者）、进程退出、会话被取消、对端撤回
 * 请求，都按「拒绝」回；从不按「批准」回。
 */

/** 人的决定；没有第三种。 */
export type ExtDecision = "approve" | "reject";

export interface ExtRequestCard {
  readonly sessionId: string;
  /** 关联到 Agent 那边的工具调用。 */
  readonly toolCallId: string;
  readonly title: string;
  /** 卡片正文（计划原文）。 */
  readonly body: string;
}

export interface AcpExtRequestSpec {
  readonly kind: "plan-approval";
  /** 请求参数 → 卡片；参数不认识时答 `undefined`（回 invalid params，不挂卡）。 */
  card(params: unknown): ExtRequestCard | undefined;
  /**
   * 人的决定 → 应答 JSON（原样作为 JSON-RPC 的 `result`）。
   *
   * **应答形状没有用真账号核对过**：目前只知道请求的形状（`sessionId`、`toolCallId`、
   * `planContent`），不知道 grok 认哪些应答字段（Armadra#1021）。所以这里是一处
   * 孤立、标为未验证的映射，核对之后只改这一个函数。
   */
  reply(decision: ExtDecision, params: unknown): unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** grok 的计划审批：请求 `{ sessionId, toolCallId, planContent }`。 */
export const GROK_EXIT_PLAN_MODE: AcpExtRequestSpec = {
  kind: "plan-approval",
  card(params) {
    const value = record(params);
    const sessionId = value?.sessionId;
    const toolCallId = value?.toolCallId;
    if (typeof sessionId !== "string" || typeof toolCallId !== "string") {
      return undefined;
    }
    const plan = value?.planContent;
    return {
      sessionId,
      toolCallId,
      title: "Plan",
      body: typeof plan === "string" ? plan : "",
    };
  },
  // 未验证（Armadra#1021）：先按最朴素的猜测写。
  reply(decision) {
    return { approved: decision === "approve" };
  },
};

/** 卡片 → 审批挂起表里的那一条工具调用。 */
export function planToolCall(card: ExtRequestCard): AcpToolCallUpdate {
  return {
    toolCallId: card.toolCallId,
    title: card.title,
    kind: "switch_mode",
    status: "pending",
    content:
      card.body === ""
        ? []
        : [{ type: "content", content: { type: "text", text: card.body } }],
  } as AcpToolCallUpdate;
}
