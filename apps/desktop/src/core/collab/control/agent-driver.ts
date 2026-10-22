import { type AgentDriver, defaultAgentDriver } from "@armadra/shared";

import { adapterFor } from "../../acp/adapters";
import {
  type AgentSettings,
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

/**
 * core 建 Agent 节点（`canvas spawn` / `team`、工作流派发）时写进
 * `agent.driver` 的值。规则与页面新建菜单是同一个共享函数
 * `defaultAgentDriver`：设置 `agents.defaultDriver` 加这家的 ACP 适配器是否
 * 装了，外加「自定义 Agent 自己的启动程序留在终端」。读不到设置（测试里没装设置域）按设置缺省 `acp`。
 *
 * 只在建节点那一刻问一次；已有节点的驱动不会被这里改写。
 */
export function newNodeDriver(
  settings: AgentSettings,
  agentId: string,
): AgentDriver {
  const document = settingsDomain()?.settings.snapshot();
  const setting = completionSettings(document ?? {}).agents.defaultDriver;
  const adapter = adapterFor(settings, agentId);
  return defaultAgentDriver({
    setting,
    acpInstalled: adapter !== undefined && probe(adapter.program) !== undefined,
    // 自定义 Agent 用自己的启动程序：ACP 会话起的是基础适配器，会绕过它。
    ownLaunch:
      customAgent(settings, agentId) !== undefined &&
      adapter?.support !== "native",
  });
}
