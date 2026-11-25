import {
  type AgentDriver,
  type AgentView,
  defaultAgentView,
} from "@armadra/shared";

import { adapterFor } from "../../acp/adapters";
import {
  type AgentSettings,
  baseAgent,
  customAgent,
  resolveCommand,
} from "../../agent/registry";
import { isInjected } from "../../hook/install/inject";
import { settingsDomain } from "../../settings";
import { Refused } from "../refusals";
import { completionSettings } from "../../settings/schema";

type Probe = (program: string) => string | undefined;

let probe: Probe = (program) => resolveCommand(program);

/** 仅测试用：换掉「适配器程序装没装」的探测；不传则恢复。 */
export function setAdapterProbeForTest(next?: Probe): void {
  probe = next ?? ((program) => resolveCommand(program));
}

/**
 * 这家 Agent 能不能开 ACP 会话：有 ACP 适配器、适配器程序装了，且不是「自定义
 * Agent 用自己的启动程序」（ACP 会话起的是基础适配器，会绕过它）。与
 * {@link newNodeView} 判 `acpInstalled` / `ownLaunch` 同一条。
 */
export function acpSurfaceAvailable(
  settings: AgentSettings,
  agentId: string,
): boolean {
  const adapter = adapterFor(settings, agentId);
  if (adapter === undefined || probe(adapter.program) === undefined) {
    return false;
  }
  return !(
    customAgent(settings, agentId) !== undefined && adapter.support !== "native"
  );
}

let preferenceOverride: AgentDriver | undefined;

/** 仅测试用：不装设置域也能指定用户的默认视图偏好；不传则恢复。 */
export function setViewPreferenceForTest(next?: AgentDriver): void {
  preferenceOverride = next;
}

/**
 * core 建 Agent 节点（`canvas open-agent` / `team`、工作流派发）时写进 `agent`
 * 的 `driver` 与 `view`。规则与页面新建菜单是同一个共享函数
 * `defaultAgentView`：设置 `agents.defaultDriver`（用户的默认视图偏好）加这家
 * 的 ACP 适配器是否装了、转录适配器有没有，外加「自定义 Agent 自己的启动程序
 * 留在终端」。读不到设置（测试里没装设置域）按设置缺省 `acp`（会话）。
 *
 * 只在建节点那一刻问一次；已有节点的驱动与节点体不会被这里改写。
 * `resume` 接回靠敲进终端的 CLI 自己的 resume 行，只有终端驱动做得到，所以不
 * 写 `driver`，但节点体仍跟随偏好。
 */
export function newNodeView(
  settings: AgentSettings,
  agentId: string,
  options: {
    readonly resume?: boolean;
    /** 调用方指定的形态（交接新开目标）：不看用户的默认视图偏好。 */
    readonly surface?: AgentDriver;
    /** 这个节点一建出来就要投第一条任务（`--task`、team 的角色任务）。 */
    readonly withTask?: boolean;
  } = {},
): { driver?: AgentDriver; view?: AgentView } {
  if (options.surface !== undefined) return { driver: options.surface };
  const base = baseAgent(settings, agentId);
  // 没有画布注入的内置 CLI（契约 §120）：终端里没有状态来源也没有技能与 MCP，
  // 投不进任务、也读不到画布。用户的「终端」偏好在这里不适用，ACP 能用就走 ACP；
  // ACP 用不了而又带着任务，建出来的节点第一条任务只会被当场取消，不如现在就拒绝。
  // 不带任务、不要求接回时仍可以建一个终端节点：它是个普通终端。
  if (!isInjected(base) && options.resume !== true) {
    if (acpSurfaceAvailable(settings, agentId)) return { driver: "acp" };
    if (options.withTask === true) {
      throw new Refused(
        400,
        "target_surface_unsupported",
        `${agentId} 的终端没有画布注入，投不进第一条任务，而它的 ACP 适配器在这台机器上不可用；先装好 ACP 入口，或去掉任务只开一个空节点。`,
      );
    }
  }
  const document = settingsDomain()?.settings.snapshot();
  const setting =
    preferenceOverride ??
    completionSettings(document ?? {}).agents.defaultDriver;
  const adapter = adapterFor(settings, agentId);
  const chosen = defaultAgentView({
    setting,
    // 接回只能终端驱动：当作 ACP 不可用，节点体照样跟随偏好。
    acpInstalled:
      options.resume !== true &&
      adapter !== undefined &&
      probe(adapter.program) !== undefined,
    // 自定义 Agent 用自己的启动程序：ACP 会话起的是基础适配器，会绕过它。
    ownLaunch:
      customAgent(settings, agentId) !== undefined &&
      adapter?.support !== "native",
    baseAgentId: baseAgent(settings, agentId),
  });
  if (options.resume === true) {
    return chosen.view === undefined ? {} : { view: chosen.view };
  }
  return chosen;
}
