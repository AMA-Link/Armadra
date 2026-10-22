import type { AgentDriver, AgentView } from "./domain/node-data.js";

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

/**
 * CLI 有转录适配器的基础代理（core `timeline/sources` 的 `ADAPTERS` 键）。
 * 终端驱动的节点只有这些才能显示会话内容；core 的测试守着两边一致。
 */
export const TRANSCRIPT_AGENT_IDS = [
  "claude",
  "codex",
  "opencode",
  "pi",
  "omp",
  "ama",
  "copilot",
] as const;

export function hasTranscript(baseAgentId: string): boolean {
  return (TRANSCRIPT_AGENT_IDS as readonly string[]).includes(baseAgentId);
}

/**
 * 新建 Agent 节点时写进 `agent` 的视图字段：驱动与（终端驱动时的）初始节点体。
 *
 * 所有建节点的入口——页面新建菜单、`canvas spawn` / `team`、工作流派发、
 * 交接新建——都调这一条，用户偏好（设置 `agents.defaultDriver`，界面叫
 * 「Agent 默认视图」）只在这里翻译一次：
 *
 * - 偏好「终端」：终端驱动、终端体。
 * - 偏好「会话」：能走 ACP 的走 ACP（会话视图）；不能走 ACP 但有转录适配器
 *   的，终端驱动、会话体（`view: "session"`，进程由 core 起）；两者都没有的
 *   只能是终端驱动、终端体。
 *
 * 终端体是缺省，所以只在会话体时才写 `view`。
 */
export function defaultAgentView(input: {
  readonly setting: AgentDriver;
  readonly acpInstalled: boolean;
  readonly ownLaunch?: boolean;
  /** `baseAgent` 之后的代理 id，用来判断有没有转录适配器。 */
  readonly baseAgentId: string;
}): { readonly driver: AgentDriver; readonly view?: AgentView } {
  const driver = defaultAgentDriver(input);
  if (driver === "terminal" && input.setting === "acp") {
    if (hasTranscript(input.baseAgentId)) {
      return { driver, view: "session" };
    }
  }
  return { driver };
}
