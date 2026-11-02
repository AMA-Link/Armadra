/**
 * 起会话前核对 CLI 本体的版本（AMA-Link/Armadra#710）。
 *
 * 适配器跑的是 PATH 上的那个 CLI；CLI 低于适配器要的版本时，适配器往往不报错，
 * 而是等一个旧 CLI 永远不会答的命令，会话挂到 `session/new` 的截止才报超时，页面
 * 只看到「启动超时」。哪家要多新由 `@armadra/shared` 的 `ACP_CLI_FLOOR` 登记，
 * 这里只负责问版本与比较：
 *
 *   * 没登记的家不核对；
 *   * 问不出版本（程序没跑起来、输出读不懂）不拦——问不出来不等于过旧；
 *   * 只在版本确实低于下限时答 `acp_cli_outdated`，`details` 带已装版本、最低版本
 *     与应装的包。
 *
 * 版本按「程序路径 + 文件修改时间 + 大小」记在内存里，升级（文件换了）立刻重问，
 * 不靠一天一次的探测缓存。
 */

import { statSync } from "node:fs";

import { acpCliFloor, acpCliOutdated, parseCliVersion } from "@armadra/shared";

import { runVersion } from "../agent/probe";
import { AGENT_REGISTRY, resolveCommand } from "../agent/registry";
import { agentPath } from "../terminal/environment";
import { AcpError } from "./client";

export type CliVersionRunner = (
  program: string,
  env: NodeJS.ProcessEnv,
) => Promise<string | undefined>;

const known = new Map<string, string>();

/** 测试用：忘掉记着的版本。 */
export function forgetCliVersions(): void {
  known.clear();
}

function stamp(program: string): string {
  try {
    const stat = statSync(program);
    return `${program}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return program;
  }
}

/**
 * 这家的 CLI 够不够新。没登记、没装、问不出版本都答 `undefined`（放行）；
 * 低于下限答 {@link AcpError}。
 */
export async function checkCliFloor(
  agentId: string,
  ambient: NodeJS.ProcessEnv = process.env,
  run: CliVersionRunner = runVersion,
): Promise<AcpError | undefined> {
  if (acpCliFloor(agentId) === undefined) return undefined;
  const launchCmd = AGENT_REGISTRY.find(
    (definition) => definition.id === agentId,
  )?.launchCmd;
  if (launchCmd === undefined) return undefined;
  const program = resolveCommand(launchCmd, ambient);
  if (program === undefined) return undefined;
  const key = stamp(program);
  let version = known.get(key);
  if (version === undefined) {
    const output = await run(program, {
      ...ambient,
      PATH: agentPath(ambient),
    });
    version =
      output === undefined ? undefined : (parseCliVersion(output) ?? undefined);
    if (version !== undefined) known.set(key, version);
  }
  const outdated = acpCliOutdated(agentId, version);
  if (outdated === undefined) return undefined;
  return new AcpError(
    "acp_cli_outdated",
    `${launchCmd} ${outdated.installed} is older than the ${outdated.minimum} the ACP adapter needs; install ${outdated.package}`,
    {
      agentId: outdated.agentId,
      installed: outdated.installed,
      minimum: outdated.minimum,
      package: outdated.package,
    },
  );
}
