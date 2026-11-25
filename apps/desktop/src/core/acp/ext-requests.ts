import type { AcpToolCallUpdate } from "@armadra/agent/acp";

/**
 * 以 `_` 开头的扩展请求（ACP 规范留给各家的位置）里，需要人决定的那一类。
 *
 * 目前只有 grok 的 `_x.ai/exit_plan_mode`：grok 在 plan 模式下把计划交给客户端审批，
 * 请求在人答之前一直挂着。它进审批挂起表（与 `session/request_permission` 同一张，
 * `AcpProcess.holdExt`），卡片正文是计划，选项是「批准 / 拒绝」；人**批准**之后，经
 * 适配器里**这一处**映射函数（{@link AcpExtRequestSpec.reply}）变成应答 JSON。
 *
 * 红线与失效安全：
 *   * 绝不自动代答；
 *   * **只有人点了批准才回成功的 `result`**。拒绝、没选、没有审批消费者（无人值守）、
 *     会话被取消、进程退出，全部抛 `RpcError`（-32800），JSON-RPC 的错误不可能被对端读成
 *     批准——哪怕映射函数的应答形状是错的；
 *   * 应答形状没核实过的规格（`verified: false`）根本不挂卡：保持现状的 -32601
 *     （method not found），依赖升级也不会让一个没核实的应答自动上线。
 */

/** 卡片正文最多这么多字符，多的截断并加省略标记。 */
export const MAX_PLAN_CHARS = 64 * 1024;

export interface ExtRequestCard {
  readonly sessionId: string;
  /** 关联到 Agent 那边的工具调用。 */
  readonly toolCallId: string;
  /** 兜底标题；页面认 {@link PLAN_CARD_MARK} 之后按语言显示自己的。 */
  readonly title: string;
  /** 卡片正文（计划原文，已截断）。 */
  readonly body: string;
}

/** 卡片 `toolCall._meta` 里的标记：页面据此把标题换成本地化的「计划审批」。 */
export const PLAN_CARD_MARK = "armadra/card";

export interface AcpExtRequestSpec {
  readonly kind: "plan-approval";
  /**
   * 应答形状核实过没有（用真账号抓过批准的应答、对过映射）。`false` 的规格不挂卡，
   * 请求照旧回 -32601。核实之后改这一个标志和 {@link reply}，别的都不用动。
   */
  readonly verified: boolean;
  /** 请求参数 → 卡片；参数不认识时答 `undefined`（回 invalid params，不挂卡）。 */
  card(params: unknown): ExtRequestCard | undefined;
  /**
   * 人批准了 → 应答 JSON（原样作为 JSON-RPC 的 `result`）。只在批准时调用；别的
   * 情况一律抛 `RpcError`，不经这里。
   *
   * **应答形状没有用真账号核对过**（Armadra#1021）：目前只知道请求的形状
   * （`sessionId`、`toolCallId`、`planContent`），不知道 grok 认哪些应答字段。
   */
  reply(params: unknown): unknown;
}

function clip(text: string): string {
  return text.length > MAX_PLAN_CHARS
    ? `${text.slice(0, MAX_PLAN_CHARS)}\n…`
    : text;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** grok 的计划审批：请求 `{ sessionId, toolCallId, planContent }`。 */
export const GROK_EXIT_PLAN_MODE: AcpExtRequestSpec = {
  kind: "plan-approval",
  // 应答形状没有用真账号核对过：不挂卡（Armadra#1021 的第 2 步核对之后改成 true）。
  verified: false,
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
      body: clip(typeof plan === "string" ? plan : ""),
    };
  },
  // 未验证（Armadra#1021）：先按最朴素的猜测写。
  reply() {
    return { approved: true };
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
    _meta: { [PLAN_CARD_MARK]: "plan" },
  } as AcpToolCallUpdate;
}
