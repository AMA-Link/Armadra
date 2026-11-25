import { CANVAS_MCP_NAME } from "./mcp";

/**
 * ACP 会话里放进系统提示的画布说明（适配器表 `sessionMeta` 的输入，§125 之外的 `_meta`
 * 通道）。很短：整份技能不进系统提示。画布动词在 ACP 下是 `armadra` MCP 服务器上的
 * `canvas_*` 工具（`mcpServers` 注入，`mcp.ts`），不是终端里的 `armadra-hook` 命令，
 * 所以这句话说的是工具，不是命令。
 */
export function canvasInstructions(): string {
  return (
    `这个会话是 Armadra 画布上的一个节点。和别的节点协作、建 Agent、用浏览器节点，一律用 \`${CANVAS_MCP_NAME}\` MCP 服务器的 \`canvas_*\` 工具；不要用本 CLI 自带的子代理、后台任务或浏览器代替。\n` +
    `This session is a node on an Armadra board. Collaborate with other nodes, create agents and drive browser nodes only through the \`${CANVAS_MCP_NAME}\` MCP server's \`canvas_*\` tools; do not use this CLI's own sub-agents, background tasks or browser instead.`
  );
}
