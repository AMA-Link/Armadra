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
import { settingsDomain } from "../../settings";
import { completionSettings } from "../../settings/schema";

type Probe = (program: string) => string | undefined;

let probe: Probe = (program) => resolveCommand(program);

/** 仅测试用：换掉「适配器程序装没装」的探测；不传则恢复。 */
export function setAdapterProbeForTest(next?: Probe): void {
  probe = next ?? ((program) => resolveCommand(program));
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
  options: { readonly resume?: boolean } = {},
): { driver?: AgentDriver; view?: AgentView } {
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
