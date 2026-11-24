import { type InjectedAgentId, injectedAgentIds } from "./agents.js";

/**
 * 零注入启动（契约 §113，#975）：设置 `agents.<id>.bareLaunch` 为真时，这家
 * Agent 从画布启动不带任何 Armadra 的参数、变量与文件，等于在终端里直接运行。
 * core 据此给节点环境加 {@link BARE_LAUNCH_ENV}，启动器见它非空就原样 `exec`。
 */

/** 节点终端环境里的零注入标记；启动器只看它是否非空。 */
export const BARE_LAUNCH_ENV = "ARMADRA_BARE";

/**
 * 有注入、因而有这个开关的 Agent：内置的、有画布注入的那几家（没有注入的内置
 * Agent 没有可关的东西，契约 §120），自定义条目不在其中。
 */
export const BARE_LAUNCH_AGENT_IDS =
  injectedAgentIds() as readonly InjectedAgentId[];

export function supportsBareLaunch(agentId: string): boolean {
  return (BARE_LAUNCH_AGENT_IDS as readonly string[]).includes(agentId);
}

/**
 * 设置文档里这家的开关。只认内置 id 下的布尔 `true`；缺席、类型不对、自定义 id
 * 一律是关。`settings` 是整份设置（或至少含 `agents` 段）。
 */
export function bareLaunchOf(settings: unknown, agentId: string): boolean {
  if (!supportsBareLaunch(agentId)) return false;
  if (typeof settings !== "object" || settings === null) return false;
  const agents = (settings as { agents?: unknown }).agents;
  if (typeof agents !== "object" || agents === null) return false;
  const entry = (agents as Record<string, unknown>)[agentId];
  if (typeof entry !== "object" || entry === null) return false;
  return (entry as { bareLaunch?: unknown }).bareLaunch === true;
}
