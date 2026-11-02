import { compareVersions } from "./agent-capabilities.js";
import { AGENT_IDS, type BuiltinAgentId } from "./agents.js";
import { AGENT_CLI_PACKAGES, type AgentCliAgentId } from "./api/acp.js";

/**
 * ACP 适配器对 CLI 本体的最低版本（AMA-Link/Armadra#710）。
 *
 * 适配器自己不带 CLI，跑的是 PATH 上那一个；CLI 太旧时适配器往往不报错，而是
 * 等一个旧 CLI 永远不会答的命令，会话一直挂到超时。这里一处写清「哪家的 CLI
 * 低于哪个版本起不来」，core 起会话前据此核对、页面据此说原因，不在代码里按
 * Agent 写分支。只登记有实测或适配器文档为据的下限；没有登记的家不核对。
 *
 * pi：适配器 `pi-acp` 在 `session/new` 里要 `get_available_thinking_levels`，Pi
 * 0.81.0 起才有（0.80.10 没有，旧 Pi 对未知命令的应答不带请求 id，适配器永远等
 * 不到）。
 */
export interface AcpCliFloor {
  /** 低于它起不来。 */
  readonly minVersion: string;
  /** 现行的 npm 包（装机、提示都指它）。 */
  readonly package: string;
}

export const ACP_CLI_FLOOR: Readonly<
  Partial<Record<BuiltinAgentId, AcpCliFloor>>
> = {
  pi: { minVersion: "0.81.0", package: AGENT_CLI_PACKAGES.pi },
};

/** 这家 CLI 的最低版本要求；没有登记（或不是内置 Agent）答 `undefined`。 */
export function acpCliFloor(agentId: string): AcpCliFloor | undefined {
  return (AGENT_IDS as readonly string[]).includes(agentId)
    ? ACP_CLI_FLOOR[agentId as BuiltinAgentId]
    : undefined;
}

/** `acp_cli_outdated` 的 `details`。 */
export interface AcpCliOutdatedDetails {
  readonly agentId: AgentCliAgentId | string;
  readonly installed: string;
  readonly minimum: string;
  readonly package: string;
}

/**
 * 已装版本是否低于下限。没有登记的家、版本不是 `x.y.z` 的（问不出来）一律答
 * `false`：问不出来不等于过旧，不拦。
 */
export function acpCliOutdated(
  agentId: string,
  installed: string | null | undefined,
): AcpCliOutdatedDetails | undefined {
  const floor = acpCliFloor(agentId);
  if (floor === undefined || !installed || !/^\d+\.\d+/.test(installed)) {
    return undefined;
  }
  return compareVersions(installed, floor.minVersion) < 0
    ? {
        agentId,
        installed,
        minimum: floor.minVersion,
        package: floor.package,
      }
    : undefined;
}
