import type { AgentDriver } from "./domain/node-data.js";

/**
 * 新建 Agent 节点时写进节点数据 `agent.driver` 的值（ACP 设计 §8 第 2 条）。
 *
 * 页面新建菜单与 core 的建节点入口（`canvas spawn` / `team`、工作流派发）共用
 * 这一条：设置 `agents.defaultDriver` 是 `acp` 且这家的适配器装了才走 ACP，
 * 否则退回终端。驱动是建节点那一刻的决定，写明而不是留空——页面与 core 都把
 * 缺省当终端，之后改设置也不该把已有节点翻成另一种视图。
 */
export function defaultAgentDriver(input: {
  readonly setting: AgentDriver;
  readonly acpInstalled: boolean;
  /**
   * 自定义 Agent 用自己的启动程序（不是基础 CLI 的 ACP 入口）：ACP 会话起的是
   * 基础适配器，会绕过它，所以留在终端驱动。
   */
  readonly ownLaunch?: boolean;
}): AgentDriver {
  return input.setting === "acp" &&
    input.acpInstalled &&
    input.ownLaunch !== true
    ? "acp"
    : "terminal";
}
