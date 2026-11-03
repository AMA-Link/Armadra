/**
 * Armadra 自己的 MCP 工具在 ACP 会话里免审批（#768，契约 §98）。
 *
 * 为什么只能在这里做：终端里的 Codex 用 `default_tools_approval_mode="approve"`
 * 起这条服务器（`hook/install/codex-mcp.ts`），ACP 会话却只能经
 * `session/new.mcpServers` 交服务器，那里的 stdio 条目只有 `name / command /
 * args / env`，适配器又把它整段写成自己的 `mcp_servers.<name>`，没有地方带审批
 * 方式。于是每一次画布工具调用都变成一条 `session/request_permission`。
 *
 * 放行不多给任何权限：`armadra-hook mcp` 与 `armadra-hook canvas` 发同样的请求、
 * 用同一个节点令牌（`mcp.ts`），core 分不出三种调用方，人点「允许」也只是放过
 * 一次已经授权过的调用。所以规则很窄：
 *
 *   * **只看来源**：服务器名是 {@link CANVAS_MCP_NAME}、工具名在 `VERB_TOOLS`
 *     里。来源取自适配器写的结构化字段（`@armadra/shared` 的 `acpMcpToolOf`），
 *     从不看标题；审批请求本身不带来源时（Codex 只给 `toolCallId`），用同一
 *     `toolCallId` 先到的 `tool_call` 里记下的来源——前提是请求里没有任何别的
 *     身份信息（标题、入参、`_meta`），有就只认请求自己的。
 *   * **只选 `allow_once`**：没有这种选项就照常交给人；从不选 `allow_always`。
 *   * `VERB_TOOLS` 里没有需要人另行审批的动词（`canvas_close` 遇到有活的节点
 *     由 core 自己去问人），与终端 Codex 整条服务器放行一致。
 */

import { acpMcpToolOf, type AcpMcpTool } from "@armadra/shared";

import { toolByName } from "../../hook-client/verbs";
import type { AcpPermissionOption, AcpToolCallUpdate } from "./types";
import { CANVAS_MCP_NAME } from "./mcp";

/** 记多少个最近的工具调用来源：够一回合里的并发调用，不随会话变长。 */
export const OWN_TOOL_LEDGER_MAX = 256;

/** 来源是 Armadra 自己那条服务器上的一个 `VERB_TOOLS` 工具。 */
export function isOwnTool(tool: AcpMcpTool | undefined): boolean {
  return (
    tool !== undefined &&
    tool.server === CANVAS_MCP_NAME &&
    toolByName(tool.tool) !== undefined
  );
}

/** 审批请求自己有没有带身份信息（有就不借 `tool_call` 记下的来源）。 */
function carriesIdentity(call: AcpToolCallUpdate): boolean {
  const body = call as Record<string, unknown>;
  return (
    body._meta !== undefined ||
    body.rawInput !== undefined ||
    (typeof body.title === "string" && body.title !== "")
  );
}

/** 要替人答时用的那个选项：Agent 给的第一个 `allow_once`；没有就不答。 */
export function allowOnceOption(
  options: readonly AcpPermissionOption[],
): AcpPermissionOption | undefined {
  return options.find((option) => option.kind === "allow_once");
}

/**
 * 一个会话里 `toolCallId` → MCP 来源（只记 Armadra 自己的工具，有上限）。
 * `tool_call` / `tool_call_update` 到时 {@link record}，审批到时
 * {@link decide}。
 */
export class OwnToolCalls {
  private readonly seen = new Map<string, AcpMcpTool>();
  private approvedTurn = 0;
  private approvedTotal = 0;

  record(update: unknown): void {
    const body = update as {
      sessionUpdate?: unknown;
      toolCallId?: unknown;
    } | null;
    if (
      body === null ||
      typeof body !== "object" ||
      (body.sessionUpdate !== "tool_call" &&
        body.sessionUpdate !== "tool_call_update") ||
      typeof body.toolCallId !== "string" ||
      body.toolCallId === ""
    ) {
      return;
    }
    const tool = acpMcpToolOf(update);
    if (!isOwnTool(tool)) return;
    this.seen.delete(body.toolCallId);
    this.seen.set(body.toolCallId, tool!);
    if (this.seen.size > OWN_TOOL_LEDGER_MAX) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  /** 这条审批的来源：请求自己带的优先，其次是同一调用先到的 `tool_call`。 */
  provenance(call: AcpToolCallUpdate): AcpMcpTool | undefined {
    if (carriesIdentity(call)) return acpMcpToolOf(call);
    return this.seen.get(call.toolCallId);
  }

  /**
   * 该不该替人答、答哪个：是自家工具且有 `allow_once` 时答它的 `optionId`，
   * 否则 `undefined`（照常交给人）。真的答上了再 {@link noteApproved}。
   */
  decide(
    call: AcpToolCallUpdate,
    options: readonly AcpPermissionOption[],
  ): string | undefined {
    if (!isOwnTool(this.provenance(call))) return undefined;
    return allowOnceOption(options)?.optionId;
  }

  /** 替人答上了一条：计数（只有数，没有工具名与参数）。 */
  noteApproved(): void {
    this.approvedTurn += 1;
    this.approvedTotal += 1;
  }

  /** 这一回合放行了几次（读完清零）与整个会话的累计：日志只记这两个数。 */
  takeTurnCounts(): { readonly turn: number; readonly total: number } {
    const counts = { turn: this.approvedTurn, total: this.approvedTotal };
    this.approvedTurn = 0;
    return counts;
  }
}
