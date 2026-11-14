/**
 * 托管平台域用的外部命令入口：`ssh -G`、`gh`、`glab`、`git credential`。
 *
 * 一个子进程不继承 core 的整个环境：只带 PATH / HOME 这类最小集合，外加调用方
 * 明确给的变量。永远不交互（stdin 关掉或只喂调用方给的那一段），带超时与输出上限。
 * 全部经 {@link CommandRunner} 注入，测试只用 mock，绝不起真的外部程序。
 */

import { execFile } from "node:child_process";

export interface CommandResult {
  readonly ok: boolean;
  readonly stdout: string;
}

export interface CommandOptions {
  readonly timeoutMs: number;
  /** 在最小环境之上追加的变量。 */
  readonly env?: Readonly<Record<string, string>>;
  /** 喂进 stdin 的内容；不给就是关掉 stdin。 */
  readonly input?: string;
}

/** 起一个外部命令。失败（找不到、非零退出、超时）一律是 `ok: false`，不抛。 */
export type CommandRunner = (
  file: string,
  args: readonly string[],
  options: CommandOptions,
) => Promise<CommandResult>;

const ENV_NAMES = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "XDG_CONFIG_HOME",
  "SystemRoot",
  "TMPDIR",
  "LANG",
] as const;

export function minimalEnv(
  extra: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}

export const realRunner: CommandRunner = (file, args, options) =>
  new Promise((resolve) => {
    const child = execFile(
      file,
      [...args],
      {
        env: minimalEnv(options.env),
        timeout: options.timeoutMs,
        maxBuffer: 1 << 20,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout) => {
        resolve({
          ok: error === null,
          stdout: typeof stdout === "string" ? stdout : "",
        });
      },
    );
    child.on("error", () => undefined);
    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();
  });
