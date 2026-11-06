/**
 * ACP 工具调用的 MCP 来源（#768）：这一次调用是哪台 MCP 服务器的哪个工具。
 *
 * 只认适配器写进结构化字段里的来源，**从不看标题**——标题是给人读的，Agent
 * 怎么写都行。两种已知写法：
 *
 *   * `_meta.is_mcp_tool_call === true` 且 `rawInput = { server, tool, arguments }`
 *     （Codex 的适配器）：`server` / `tool` 是它从 MCP 调用本身取的，模型只能
 *     填 `arguments`；
 *   * `_meta.claudeCode.toolName = "mcp__<server>__<tool>"`（Claude 的适配器），
 *     同时带 `_meta.claudeCode.mcpServer.name` 时两者必须一致。
 *
 * 只有其一的、形状不对的都答 `undefined`：宁可当成普通工具，也不猜。
 *
 * core 用它决定要不要替人放行（只放行 {@link ARMADRA_MCP_SERVER} 上
 * `VERB_TOOLS` 里的工具，`core/acp/own-tools.ts`），时间线用它记 `mcp` 字段，
 * 页面用它换掉原始 id。
 */

/** Armadra 自己那条 MCP 服务器的名字（`core/acp/mcp.ts::CANVAS_MCP_NAME`）。 */
export const ARMADRA_MCP_SERVER = "armadra";

/**
 * `armadra-hook mcp` 的工具名，与 `apps/desktop/src/hook-client/verbs.ts` 的
 * `VERB_TOOLS` 逐项相同、同序（那边的 `verbs.test.ts` 守着）。复制而不导入：
 * 页面不能依赖桌面端的源码。页面按它取文案与图标；core 放行时认的是
 * `VERB_TOOLS` 本身。
 */
export const ARMADRA_MCP_TOOLS = [
  "canvas_help",
  "canvas_post",
  "canvas_inbox",
  "canvas_ack",
  "canvas_handoff_read",
  "canvas_list",
  "canvas_open_terminal",
  "canvas_open_agent",
  "canvas_open_browser",
  "canvas_sticky",
  "canvas_link",
  "canvas_rename",
  "canvas_color",
  "canvas_interrupt",
  "canvas_close",
  "canvas_send",
  "canvas_outbox",
  "canvas_cancel",
  "canvas_team",
  "canvas_workflow_propose",
  "canvas_wait",
  "canvas_report",
  "canvas_handback",
  "canvas_items",
  "canvas_events",
  "canvas_notify",
  "canvas_intake",
  "context_list",
  "context_summary",
  "context_transcript",
  "context_terminal",
  "browser_navigate",
  "browser_back",
  "browser_forward",
  "browser_read",
  "browser_click",
  "browser_hover",
  "browser_drag",
  "browser_type",
  "browser_fill",
  "browser_select",
  "browser_press",
  "browser_scroll",
  "browser_wait",
  "browser_capture",
  "browser_pdf",
  "browser_resize",
  "browser_upload",
  "browser_download",
  "browser_tabs",
  "browser_close",
  "browser_dialog",
  "browser_lease",
] as const;

export type ArmadraMcpTool = (typeof ARMADRA_MCP_TOOLS)[number];

const ARMADRA_TOOL_SET: ReadonlySet<string> = new Set(ARMADRA_MCP_TOOLS);

export function isArmadraMcpToolName(name: string): name is ArmadraMcpTool {
  return ARMADRA_TOOL_SET.has(name);
}

export interface AcpMcpTool {
  readonly server: string;
  readonly tool: string;
}

/** 服务器名与工具名的上限（时间线 schema 同一个数）。 */
export const MCP_NAME_MAX = 200;

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function name(value: unknown): string | undefined {
  return typeof value === "string" &&
    value !== "" &&
    value.length <= MCP_NAME_MAX
    ? value
    : undefined;
}

/** `mcp__<server>__<tool>`：服务器名里不含 `__`，所以第一个分隔就是边界。 */
function splitClaudeToolName(full: string): AcpMcpTool | undefined {
  if (!full.startsWith("mcp__")) return undefined;
  const rest = full.slice(5);
  const cut = rest.indexOf("__");
  if (cut <= 0) return undefined;
  const server = name(rest.slice(0, cut));
  const tool = name(rest.slice(cut + 2));
  return server !== undefined && tool !== undefined
    ? { server, tool }
    : undefined;
}

/**
 * 一条 `tool_call` / `tool_call_update` 或审批请求里的 `toolCall` 的 MCP 来源；
 * 不是 MCP 调用（或认不出）时答 `undefined`。
 */
export function acpMcpToolOf(call: unknown): AcpMcpTool | undefined {
  const body = obj(call);
  if (body === null) return undefined;
  const meta = obj(body._meta);
  if (meta === null) return undefined;
  if (meta.is_mcp_tool_call === true) {
    const input = obj(body.rawInput);
    const server = name(input?.server);
    const tool = name(input?.tool);
    if (server !== undefined && tool !== undefined) return { server, tool };
    return undefined;
  }
  const claude = obj(meta.claudeCode);
  const toolName = name(claude?.toolName);
  if (toolName === undefined) return undefined;
  const parsed = splitClaudeToolName(toolName);
  if (parsed === undefined) return undefined;
  const declared = obj(claude?.mcpServer);
  if (declared !== null && declared.name !== parsed.server) return undefined;
  return parsed;
}

/** Armadra 自己那条服务器上、`ARMADRA_MCP_TOOLS` 里的工具。 */
export function isArmadraMcpTool(
  tool: AcpMcpTool | undefined,
): tool is { server: typeof ARMADRA_MCP_SERVER; tool: ArmadraMcpTool } {
  return (
    tool !== undefined &&
    tool.server === ARMADRA_MCP_SERVER &&
    isArmadraMcpToolName(tool.tool)
  );
}

/**
 * MCP 调用的入参：Codex 的写法把模型给的参数包在 `{ server, tool, arguments }`
 * 里，摘要应读 `arguments`；其余写法 `rawInput` 本身就是参数。`known` 是这次
 * 调用先前认定的来源——Codex 的后续帧不再带 `_meta`，但包装还是同一层。
 */
export function acpMcpArguments(call: unknown, known?: AcpMcpTool): unknown {
  const body = obj(call);
  if (body === null) return undefined;
  const input = obj(body.rawInput);
  const wrapped =
    obj(body._meta)?.is_mcp_tool_call === true ||
    (known !== undefined &&
      input !== null &&
      input.server === known.server &&
      input.tool === known.tool &&
      "arguments" in input);
  return wrapped ? input?.arguments : body.rawInput;
}
