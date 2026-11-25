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
 * pi：ama 的 pi 桥（`ama --mode acp --bridge pi`）要 `agent_settled` 的
 * `aborted`，Pi 1.1.0 起才有；更旧的 Pi 对未知命令的应答不带请求 id，桥永远等不
 * 到。已验证区间 `>=1.1.0 <2.0.0`，更新的版本照跑、由桥自己提示。
 */
export interface AcpCliFloor {
  /** 低于它起不来。 */
  readonly minVersion: string;
  /** 现行的 npm 包（装机、提示都指它）；没有 npm 包的 CLI 不写。 */
  readonly package?: string;
  /**
   * 没有 npm 包的 CLI 自己的升级命令（如 `agy update`）。提示用它代替
   * 「请安装 <包>」；有 `package` 时以包为准。
   */
  readonly updateCommand?: string;
}

export const ACP_CLI_FLOOR: Readonly<
  Partial<Record<BuiltinAgentId, AcpCliFloor>>
> = {
  pi: { minVersion: "1.1.0", package: AGENT_CLI_PACKAGES.pi },
  // 1.5.15 fixed `session/load` (it answered before the replay finished and
  // cut a long one off), the `-32002` for an unknown session, tool calls left
  // open after `session/cancel`, and turns ending while background work ran.
  // agy has no npm package: it updates itself.
  agy: { minVersion: "1.5.15", updateCommand: "agy update" },
  // grok：ACP 入口的行为（`_meta` 以外的 `mcpServers`、`session/load` /
  // `resume`、`--plugin-dir`）只在 1.0.92 实测过；更旧的（stable 通道的 1.0.77）
  // 终端能力有，ACP 没验证，宁可提示升级。
  grok: { minVersion: "1.0.92", package: AGENT_CLI_PACKAGES.grok },
};

/** 这家 CLI 的最低版本要求；没有登记（或不是内置 Agent）答 `undefined`。 */
export function acpCliFloor(agentId: string): AcpCliFloor | undefined {
  return (AGENT_IDS as readonly string[]).includes(agentId)
    ? ACP_CLI_FLOOR[agentId as BuiltinAgentId]
    : undefined;
}

/** 下限登记里给用户的那句指引（包或升级命令），没有就不带。 */
export function floorHint(
  floor: AcpCliFloor,
): Pick<AcpCliOutdatedDetails, "package" | "updateCommand"> {
  return {
    ...(floor.package === undefined ? {} : { package: floor.package }),
    ...(floor.updateCommand === undefined
      ? {}
      : { updateCommand: floor.updateCommand }),
  };
}

/** `acp_cli_outdated` 的 `details`。 */
export interface AcpCliOutdatedDetails {
  readonly agentId: AgentCliAgentId | string;
  readonly installed: string;
  readonly minimum: string;
  readonly package?: string;
  readonly updateCommand?: string;
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
        ...floorHint(floor),
      }
    : undefined;
}
