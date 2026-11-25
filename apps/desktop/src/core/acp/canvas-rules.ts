import { CANVAS_MCP_NAME } from "./mcp";

/**
 * ACP 会话里放进系统提示的画布规则（适配器表 `sessionMeta` 的输入，§126）。很短：
 * 整份技能不进系统提示，细则在 MCP 服务器自己的 instructions 里，这里只是放在最前面的
 * 复述。写法与 `collab/skill.ts` 的 `canvasRules()` 一致：画布动词在 ACP 下是
 * `armadra` MCP 服务器上的工具（`canvas_*`、`context_*`、`browser_*`，`mcpServers`
 * 注入），不是终端里的 `armadra-hook` 命令。名字写错前缀模型就搜不到（grok 先
 * `search_tool` 查名字），所以三个前缀都写全。
 *
 * 只在这个会话真的带了画布 MCP 时才用（`adapterStartOptions`）：没有 MCP 就不该告诉
 * 模型「一律用 armadra 的工具」。
 */
export function acpCanvasRules(): string {
  return (
    `这个会话是 Armadra 画布上的一个节点。和别的节点协作、建 Agent、读相连节点、用浏览器节点，一律用 \`${CANVAS_MCP_NAME}\` MCP 服务器的工具（\`canvas_*\`、\`context_*\`、\`browser_*\`）；不要用本 CLI 自带的子代理、后台任务或浏览器代替。\n` +
    `This session is a node on an Armadra board. Collaborate with other nodes, create agents, read linked nodes and drive browser nodes only through the \`${CANVAS_MCP_NAME}\` MCP server's tools (\`canvas_*\`, \`context_*\`, \`browser_*\`); do not use this CLI's own sub-agents, background tasks or browser instead.`
  );
}
