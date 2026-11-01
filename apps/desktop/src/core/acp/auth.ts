/**
 * 登录与登出（P1-3）：Agent 的 `session/new` 答 `-32000`（`acp_auth_required`）
 * 之后，页面把 Agent 声明的登录方式列出来，人选一个，core 在这里跑完，页面再
 * 重试起会话。
 *
 *   * **agent 型**方法：适配器自己完成（它在自己的进程里开浏览器、写自己的凭据），
 *     客户端只发 `authenticate(methodId)` 等它答。
 *   * **terminal 型**方法：宿主跑——适配器那条启动命令加上方法自己的 `args`、环境
 *     叠上方法自己的 `env`，退出码 0 就是成功。不经 shell，不留输出（登录输出可能
 *     带一次性口令，不进日志也不进答复）。
 *   * **登出**：Agent 声明了 `auth.logout`（或客户端的 `supportsLogout()` 为真）时，
 *     发 `logout()`。
 *
 * 这几个方法在 `@armadra/agent` 0.11 的客户端上都没有（上游更新的版本才加）：
 * 一律按实例上有没有函数做特性检测，客户端旧就答 `acp_auth_unsupported`，页面
 * 据列表里的 `supported: false` 收起按钮。登录用的是短命的适配器进程；成功后凭据
 * 在 CLI 自己的目录里，页面重试起会话就能用。
 */

import { spawn } from "node:child_process";

import { AcpError, messageOf } from "./client";
import {
  type AcpAuthMethodInfo,
  type AcpCapabilities,
  type AcpStartOptions,
  type AdapterProcessContext,
  withAdapterProcess,
} from "./host";
import { signalTree } from "./terminals";

/** 新版客户端多出来的那几个方法（0.11 没有，按实例检测）。 */
export interface AcpAuthClient {
  authenticate?(methodId: string, signal?: AbortSignal): Promise<unknown>;
  logout?(signal?: AbortSignal): Promise<unknown>;
  supportsLogout?(): boolean;
}

/** 这个客户端实例能不能走 `authenticate`。 */
export function canAuthenticate(client: unknown): boolean {
  return typeof (client as AcpAuthClient).authenticate === "function";
}

/**
 * 能不能登出：实例有 `logout` 函数，且 Agent 声明了（`supportsLogout()` 优先，
 * 没有它就看 `initialize` 里的 `auth.logout`）。
 */
export function canLogout(
  client: unknown,
  capabilities: Pick<AcpCapabilities, "logout">,
): boolean {
  const auth = client as AcpAuthClient;
  if (typeof auth.logout !== "function") return false;
  return typeof auth.supportsLogout === "function"
    ? auth.supportsLogout() === true
    : capabilities.logout;
}

/** terminal 型方法的命令行：适配器的启动命令 + 启动参数 + 方法自己的参数。 */
export function terminalAuthCommand(
  launch: {
    readonly program: string;
    readonly args: readonly string[];
    readonly env?: NodeJS.ProcessEnv;
  },
  method: Pick<AcpAuthMethodInfo, "args" | "env">,
): { program: string; args: string[]; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = { ...(launch.env ?? process.env) };
  for (const [name, value] of Object.entries(method.env ?? {})) {
    // 装载器注入类的变量一律不给（与 Agent 要的终端同一条规矩）。
    if (name.startsWith("LD_") || name.startsWith("DYLD_")) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    env[name] = value;
  }
  return {
    program: launch.program,
    args: [...launch.args, ...(method.args ?? [])],
    env,
  };
}

/** 跑完一条登录命令：退出码，`null` = 被信号杀掉 / 超时 / 取消。 */
export type AuthTerminalRunner = (
  command: {
    readonly program: string;
    readonly args: readonly string[];
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
  },
  signal: AbortSignal,
) => Promise<{ readonly exitCode: number | null }>;

/** 一次终端登录最多等多久（人要在浏览器里点完）。 */
export const AUTH_TERMINAL_TIMEOUT_MS = 10 * 60_000;

/** 缺省的跑法：不经 shell 起子进程（自成进程组），输出丢掉，取消 / 超时整组收掉。 */
export const runAuthTerminal: AuthTerminalRunner = (command, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return resolve({ exitCode: null });
    let child;
    try {
      child = spawn(command.program, [...command.args], {
        cwd: command.cwd,
        env: command.env,
        stdio: ["ignore", "ignore", "ignore"],
        detached: process.platform !== "win32",
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      return reject(
        new AcpError(
          "acp_auth_failed",
          `cannot start ${command.program}: ${messageOf(error)}`,
        ),
      );
    }
    const stop = () => {
      if (child.pid !== undefined) signalTree(child.pid, "SIGTERM");
    };
    signal.addEventListener("abort", stop, { once: true });
    child.once("error", (error) => {
      signal.removeEventListener("abort", stop);
      reject(
        new AcpError(
          "acp_auth_failed",
          `cannot start ${command.program}: ${messageOf(error)}`,
        ),
      );
    });
    child.once("exit", (code) => {
      signal.removeEventListener("abort", stop);
      resolve({ exitCode: code });
    });
  });

export interface AuthenticateOptions {
  readonly methodId: string;
  /** 跑 terminal 型方法的执行者；缺省 {@link runAuthTerminal}。 */
  readonly runTerminal?: AuthTerminalRunner;
  /** 终端登录的截止；缺省 {@link AUTH_TERMINAL_TIMEOUT_MS}。 */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

type AdapterLaunch = Pick<
  AcpStartOptions,
  | "agentId"
  | "program"
  | "args"
  | "cwd"
  | "env"
  | "initializeTimeoutMs"
  | "transport"
>;

/** 回调需要的那一小块（测试里的假客户端也能凑出来）。 */
export type AuthContext = Pick<
  AdapterProcessContext,
  "capabilities" | "launch"
> & {
  readonly process: { readonly client: unknown };
};

/**
 * 在一个已经协商好的适配器上完成一次登录。成功什么也不答；客户端旧、方法认不
 * 出、登录没成功各有各的码。
 */
export async function authenticateOn(
  context: AuthContext,
  options: AuthenticateOptions,
): Promise<void> {
  const method = context.capabilities.authMethods.find(
    (item) => item.id === options.methodId,
  );
  if (method === undefined) {
    throw new AcpError(
      "acp_auth_failed",
      `the agent has no sign-in method ${options.methodId}`,
    );
  }
  if (!canAuthenticate(context.process.client)) {
    throw new AcpError(
      "acp_auth_unsupported",
      "this build's ACP client cannot sign in to an agent",
    );
  }
  if (method.type === "terminal") {
    const command = terminalAuthCommand(context.launch, method);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? AUTH_TERMINAL_TIMEOUT_MS,
    );
    timer.unref?.();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const { exitCode } = await (options.runTerminal ?? runAuthTerminal)(
        { ...command, cwd: context.launch.cwd },
        controller.signal,
      );
      if (exitCode !== 0) {
        throw new AcpError(
          "acp_auth_failed",
          exitCode === null
            ? "the sign-in command did not finish"
            : `the sign-in command exited with code ${String(exitCode)}`,
        );
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
    return;
  }
  try {
    await (context.process.client as AcpAuthClient).authenticate?.(
      options.methodId,
      options.signal,
    );
  } catch (error) {
    throw new AcpError("acp_auth_failed", messageOf(error));
  }
}

/** 登出：Agent 声明了、客户端也有才行，否则 `acp_auth_unsupported`。 */
export async function logoutOn(
  context: AuthContext,
  options: { readonly signal?: AbortSignal } = {},
): Promise<void> {
  if (!canLogout(context.process.client, context.capabilities)) {
    throw new AcpError(
      "acp_auth_unsupported",
      "the agent cannot sign out from here",
    );
  }
  try {
    await (context.process.client as AcpAuthClient).logout?.(options.signal);
  } catch (error) {
    throw new AcpError("acp_auth_failed", messageOf(error));
  }
}

export const authenticateAdapter = (
  launch: AdapterLaunch,
  options: AuthenticateOptions,
): Promise<void> =>
  withAdapterProcess(launch, (context) => authenticateOn(context, options));

export const logoutAdapter = (
  launch: AdapterLaunch,
  options: { readonly signal?: AbortSignal } = {},
): Promise<void> =>
  withAdapterProcess(launch, (context) => logoutOn(context, options));
