/**
 * ACP 客户端终端能力（`terminal/create|output|wait_for_exit|kill|release`；
 * ACP 渐进式展示设计 §6，B9）。
 *
 * Agent 把命令交给 core 跑，core 在会话 cwd 下起子进程、攒输出尾部、报退出码。
 * 一个会话一个 {@link AcpTerminals}：
 *
 *   * **权限**：命令本身的审批由 Agent 经 `session/request_permission` 走现有
 *     的审批通道，这里不代答、不放行。这里只多一层闸：回合没在跑（`authorize`
 *     为假）、会话不是它的、已收尾，一律拒绝开终端。
 *   * **cwd**：必须落在 `roots`（会话 cwd、工作空间根）之内，符号链接解开后再
 *     比；越界回 `invalidParams`。
 *   * **输出上限**：内存里只留尾部 {@link TERMINAL_OUTPUT_LIMIT}（Agent 给的
 *     `outputByteLimit` 只能更小），超出从头部丢，在字符边界上切，`truncated`
 *     为真。同时存活的终端不超过 {@link MAX_LIVE_TERMINALS}。
 *   * **回收**：子进程自成进程组（unix）/ `taskkill /T`（Windows），按 pid 回收。
 *     `kill` 先 SIGTERM、过 {@link KILL_GRACE_MS} 仍在再 SIGKILL；`release` 和
 *     {@link AcpTerminals.dispose}（会话结束）都会收掉还活着的。
 *   * **环境**：`env` 来自 core（节点环境），Agent 给的 `env` 叠上去，但装载器
 *     注入类的变量（`LD_*`、`DYLD_*`）一律丢掉。
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { RPC_ERRORS, RpcError } from "@armadra/agent/acp";

/** 一个终端在内存里最多留多少输出（尾部）。 */
export const TERMINAL_OUTPUT_LIMIT = 256 * 1024;
/** 同一会话同时存活（没退出、没释放）的终端上限。 */
export const MAX_LIVE_TERMINALS = 8;
/** 带上了命令行的总长度上限。 */
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_ENV_ENTRIES = 64;
const MAX_ENV_VALUE_BYTES = 32 * 1024;
/** `kill` 的 SIGTERM 之后再等多久才 SIGKILL。 */
export const KILL_GRACE_MS = 1_500;
/** 输出变化通知的最小间隔（退出立即通知）。 */
export const CHANGE_INTERVAL_MS = 120;
/** 进程退出后等管道读完的最长时间（孙进程握着管道时不能一直等）。 */
const STREAM_DRAIN_MS = 200;
/** `dispose` 最多等多久子进程真的没了。 */
const DISPOSE_WAIT_MS = 3_000;

export interface TerminalExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

/** 一个终端此刻的样子：时间线与 `terminal/output` 都从这里取。 */
export interface TerminalSnapshot {
  readonly terminalId: string;
  readonly command: string;
  /** 输出尾部（字符边界上切过）。 */
  readonly output: string;
  readonly truncated: boolean;
  /** 到目前为止收到的总字节数（含已丢的头部）。 */
  readonly totalBytes: number;
  /** `null`：还在跑。 */
  readonly exit: TerminalExit | null;
}

export interface AcpTerminalsOptions {
  /** 允许的 cwd 根；第一个是缺省 cwd。 */
  readonly roots: readonly string[];
  /** 子进程的基础环境；缺省 `process.env`。 */
  readonly env?: NodeJS.ProcessEnv;
  /** 这个会话的 ACP 会话 id；还没开好时 `undefined`（此时一律拒绝）。 */
  readonly sessionId: () => string | undefined;
  /** 现在能不能开新终端：会话活着、回合在跑。 */
  readonly authorize: () => boolean;
  /** 输出或退出码变了（节流过）。 */
  readonly onChange?: (snapshot: TerminalSnapshot) => void;
  readonly outputLimit?: number;
  readonly maxTerminals?: number;
}

/** 尾部缓冲：超过两倍上限才压缩一次，摊下来每字节常数次拷贝。 */
class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  private total = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.byteLength;
    this.total += chunk.byteLength;
    if (this.size > this.limit * 2) this.compact();
  }

  get totalBytes(): number {
    return this.total;
  }

  get truncated(): boolean {
    return this.total > this.limit;
  }

  text(): string {
    this.compact();
    const joined = this.chunks[0] ?? Buffer.alloc(0);
    let start = 0;
    // 从头部切掉的位置可能落在多字节字符中间：跳过续字节。
    if (this.truncated) {
      while (
        start < joined.byteLength &&
        ((joined[start] as number) & 0xc0) === 0x80
      ) {
        start++;
      }
    }
    return joined.subarray(start).toString("utf8");
  }

  private compact(): void {
    if (this.chunks.length === 0) return;
    const joined = Buffer.concat(this.chunks);
    const kept =
      joined.byteLength > this.limit
        ? joined.subarray(joined.byteLength - this.limit)
        : joined;
    this.chunks = [Buffer.from(kept)];
    this.size = kept.byteLength;
  }
}

interface Terminal {
  readonly id: string;
  readonly command: string;
  readonly child: ChildProcess;
  readonly buffer: TailBuffer;
  readonly pid: number | undefined;
  exit: TerminalExit | undefined;
  readonly waiters: Array<(exit: TerminalExit) => void>;
  readonly exited: Promise<void>;
  changeTimer: ReturnType<typeof setTimeout> | undefined;
  killTimer: ReturnType<typeof setTimeout> | undefined;
  released: boolean;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RpcError(RPC_ERRORS.invalidParams, "params must be an object");
  }
  return value as Record<string, unknown>;
}

function invalid(message: string): RpcError {
  return new RpcError(RPC_ERRORS.invalidParams, message);
}

/** 沿路径往上找第一个存在的祖先，解开符号链接，再接回剩下的部分。 */
function realTarget(path: string): string {
  const rest: string[] = [];
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    rest.unshift(current.slice(parent.length).replace(/^[\\/]+/, ""));
    current = parent;
  }
  let real: string;
  try {
    real = realpathSync(current);
  } catch {
    real = current;
  }
  return rest.length === 0 ? real : resolve(real, ...rest);
}

/** `path` 是不是 `root` 本身或其内部（两边都先解开符号链接）。 */
export function isWithin(root: string, path: string): boolean {
  const base = realTarget(resolve(root));
  const target = realTarget(resolve(path));
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** 装载器注入类变量：Agent 给的环境里一律丢掉。 */
function loaderVariable(name: string): boolean {
  return name.startsWith("LD_") || name.startsWith("DYLD_");
}

function launchOf(
  command: string,
  args: readonly string[],
): { program: string; args: string[] } {
  // Agent 常把整条命令行放在 `command` 里、不给 `args`：此时交给 shell 解析，
  // 与它自己的 Bash 工具一致（审批已经在 `session/request_permission` 做过）。
  if (args.length === 0 && /\s/.test(command.trim())) {
    if (process.platform === "win32") {
      return {
        program: process.env.ComSpec ?? "cmd.exe",
        args: ["/d", "/s", "/c", command],
      };
    }
    const shell = process.env.SHELL;
    return {
      program: shell !== undefined && isAbsolute(shell) ? shell : "/bin/sh",
      args: ["-c", command],
    };
  }
  return { program: command, args: [...args] };
}

function signalTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // 已经没了。
    }
  }
}

export class AcpTerminals {
  private readonly terminals = new Map<string, Terminal>();
  private readonly limit: number;
  private readonly maxTerminals: number;
  private disposed = false;

  constructor(private readonly options: AcpTerminalsOptions) {
    this.limit = options.outputLimit ?? TERMINAL_OUTPUT_LIMIT;
    this.maxTerminals = options.maxTerminals ?? MAX_LIVE_TERMINALS;
  }

  /** 还活着的终端子进程的 pid（测试与诊断用）。 */
  get pids(): number[] {
    const out: number[] = [];
    for (const terminal of this.terminals.values()) {
      if (terminal.exit === undefined && terminal.pid !== undefined) {
        out.push(terminal.pid);
      }
    }
    return out;
  }

  /** `AcpClient.onTerminal` 的实现：按方法分发。 */
  async handle(
    method: string,
    params: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const p = record(params);
    this.checkSession(p);
    switch (method) {
      case "terminal/create":
        return this.create(p);
      case "terminal/output":
        return this.output(this.find(p));
      case "terminal/wait_for_exit":
        return this.waitForExit(this.find(p), signal);
      case "terminal/kill":
        this.kill(this.find(p));
        return {};
      case "terminal/release":
        this.release(this.find(p));
        return {};
      default:
        throw new RpcError(
          RPC_ERRORS.methodNotFound,
          `client does not support ${method}`,
        );
    }
  }

  /** 某个终端此刻的快照；没有（或已释放）为 `undefined`。 */
  snapshot(terminalId: string): TerminalSnapshot | undefined {
    const terminal = this.terminals.get(terminalId);
    return terminal === undefined ? undefined : this.snapshotOf(terminal);
  }

  /**
   * 会话结束：还活着的子进程一律 SIGKILL（整个进程组），等它们真的没了（有上限）。
   * 之后不再开新终端。
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    const waits: Promise<void>[] = [];
    for (const terminal of this.terminals.values()) {
      terminal.released = true;
      if (terminal.changeTimer !== undefined)
        clearTimeout(terminal.changeTimer);
      if (terminal.killTimer !== undefined) clearTimeout(terminal.killTimer);
      if (terminal.exit === undefined && terminal.pid !== undefined) {
        signalTree(terminal.pid, "SIGKILL");
        waits.push(terminal.exited);
      }
    }
    this.terminals.clear();
    if (waits.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(waits),
      new Promise<void>((done) => {
        timer = setTimeout(done, DISPOSE_WAIT_MS);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
  }

  /* -------------------------------- 方法 -------------------------------- */

  private checkSession(params: Record<string, unknown>): void {
    const expected = this.options.sessionId();
    if (expected === undefined || params.sessionId !== expected) {
      throw invalid("unknown session");
    }
  }

  private find(params: Record<string, unknown>): Terminal {
    const id = params.terminalId;
    const terminal =
      typeof id === "string" ? this.terminals.get(id) : undefined;
    if (terminal === undefined) throw invalid("unknown terminal");
    return terminal;
  }

  private create(params: Record<string, unknown>): { terminalId: string } {
    if (this.disposed || !this.options.authorize()) {
      throw new RpcError(
        RPC_ERRORS.invalidRequest,
        "terminal/create is only allowed while a turn is running",
      );
    }
    const live = [...this.terminals.values()].filter(
      (terminal) => terminal.exit === undefined,
    ).length;
    if (live >= this.maxTerminals) {
      throw new RpcError(
        RPC_ERRORS.invalidRequest,
        `too many running terminals (limit ${this.maxTerminals})`,
      );
    }
    const command = params.command;
    if (typeof command !== "string" || command.trim() === "") {
      throw invalid("command must be a non-empty string");
    }
    const args = params.args === undefined ? [] : params.args;
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
      throw invalid("args must be an array of strings");
    }
    if (
      Buffer.byteLength(command) +
        args.reduce((n: number, arg: string) => n + Buffer.byteLength(arg), 0) >
      MAX_COMMAND_BYTES
    ) {
      throw invalid("command is too long");
    }
    const cwd = this.cwdOf(params.cwd);
    const env = this.envOf(params.env);
    const requested = params.outputByteLimit;
    const limit =
      typeof requested === "number" &&
      Number.isFinite(requested) &&
      requested > 0
        ? Math.min(Math.floor(requested), this.limit)
        : this.limit;

    const launch = launchOf(command, args as string[]);
    const display =
      args.length === 0 ? command : [command, ...(args as string[])].join(" ");
    const id = randomUUID();
    const buffer = new TailBuffer(limit);
    let child: ChildProcess;
    try {
      child = spawn(launch.program, launch.args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      throw new RpcError(
        RPC_ERRORS.internalError,
        `cannot start ${launch.program}: ${messageOf(error)}`,
      );
    }
    let markExited: () => void = () => {};
    const exited = new Promise<void>((done) => {
      markExited = done;
    });
    const terminal: Terminal = {
      id,
      command: display,
      child,
      buffer,
      pid: child.pid,
      exit: undefined,
      waiters: [],
      exited,
      changeTimer: undefined,
      killTimer: undefined,
      released: false,
    };
    this.terminals.set(id, terminal);

    let open = 0;
    let drained: () => void = () => {};
    const streamsDone = new Promise<void>((done) => {
      drained = done;
    });
    for (const stream of [child.stdout, child.stderr]) {
      if (stream === null || stream === undefined) continue;
      open++;
      stream.on("data", (chunk: Buffer) => {
        buffer.push(chunk);
        this.scheduleChange(terminal);
      });
      const end = () => {
        open--;
        if (open <= 0) drained();
      };
      stream.on("close", end);
      stream.on("error", () => {});
    }
    if (open === 0) drained();

    const finish = (exit: TerminalExit) => {
      if (terminal.exit !== undefined) return;
      terminal.exit = exit;
      if (terminal.killTimer !== undefined) clearTimeout(terminal.killTimer);
      if (terminal.changeTimer !== undefined)
        clearTimeout(terminal.changeTimer);
      terminal.changeTimer = undefined;
      for (const waiter of terminal.waiters.splice(0)) waiter(exit);
      markExited();
      if (!terminal.released)
        this.options.onChange?.(this.snapshotOf(terminal));
    };
    child.on("error", (error) => {
      buffer.push(Buffer.from(`${messageOf(error)}\n`));
      finish({ exitCode: 127, signal: null });
    });
    child.on("exit", (code, signal) => {
      // 管道里剩下的字节还在路上：等读完（有上限）再报退出，输出才完整。
      let timer: ReturnType<typeof setTimeout> | undefined;
      void Promise.race([
        streamsDone,
        new Promise<void>((done) => {
          timer = setTimeout(done, STREAM_DRAIN_MS);
        }),
      ]).then(() => {
        if (timer !== undefined) clearTimeout(timer);
        finish({ exitCode: code, signal });
      });
    });
    if (child.pid === undefined) {
      // 异步失败（ENOENT）由上面的 `error` 事件收口。
      child.on("error", () => {});
    }
    return { terminalId: id };
  }

  private output(terminal: Terminal): {
    output: string;
    truncated: boolean;
    exitStatus?: { exitCode: number | null; signal: string | null };
  } {
    const snapshot = this.snapshotOf(terminal);
    return {
      output: snapshot.output,
      truncated: snapshot.truncated,
      ...(snapshot.exit === null
        ? {}
        : {
            exitStatus: {
              exitCode: snapshot.exit.exitCode,
              signal: snapshot.exit.signal,
            },
          }),
    };
  }

  private waitForExit(
    terminal: Terminal,
    signal: AbortSignal,
  ): Promise<TerminalExit> {
    if (terminal.exit !== undefined) return Promise.resolve(terminal.exit);
    return new Promise<TerminalExit>((resolvePromise, reject) => {
      const onAbort = () =>
        reject(
          new RpcError(RPC_ERRORS.requestCancelled, "wait_for_exit cancelled"),
        );
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      terminal.waiters.push((exit) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(exit);
      });
    });
  }

  private kill(terminal: Terminal): void {
    if (terminal.exit !== undefined || terminal.pid === undefined) return;
    const pid = terminal.pid;
    signalTree(pid, "SIGTERM");
    if (terminal.killTimer !== undefined) return;
    terminal.killTimer = setTimeout(() => {
      terminal.killTimer = undefined;
      if (terminal.exit === undefined) signalTree(pid, "SIGKILL");
    }, KILL_GRACE_MS);
    terminal.killTimer.unref?.();
  }

  private release(terminal: Terminal): void {
    if (terminal.changeTimer !== undefined) clearTimeout(terminal.changeTimer);
    terminal.changeTimer = undefined;
    // 最后一次输出还没来得及通知：释放前补报，时间线上的输出才是完整的。
    this.options.onChange?.(this.snapshotOf(terminal));
    terminal.released = true;
    this.terminals.delete(terminal.id);
    if (terminal.exit === undefined && terminal.pid !== undefined) {
      // 释放即不要了：不再留 SIGTERM 的情面，免得它在后台悄悄跑。
      signalTree(terminal.pid, "SIGKILL");
    }
  }

  /* -------------------------------- 辅助 -------------------------------- */

  private cwdOf(value: unknown): string {
    const roots = this.options.roots;
    const base = roots[0];
    if (base === undefined) throw invalid("no working directory");
    if (value === undefined || value === null) return base;
    if (typeof value !== "string" || value === "") {
      throw invalid("cwd must be a string");
    }
    const target = resolve(base, value);
    if (!roots.some((root) => isWithin(root, target))) {
      throw invalid("cwd is outside the workspace");
    }
    if (!existsSync(target)) throw invalid("cwd does not exist");
    return target;
  }

  private envOf(value: unknown): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...(this.options.env ?? process.env) };
    if (value === undefined || value === null) return env;
    if (!Array.isArray(value) || value.length > MAX_ENV_ENTRIES) {
      throw invalid("env must be a short array of { name, value }");
    }
    for (const entry of value) {
      const e = record(entry);
      const name = e.name;
      const text = e.value;
      if (
        typeof name !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
        typeof text !== "string" ||
        Buffer.byteLength(text) > MAX_ENV_VALUE_BYTES
      ) {
        throw invalid("invalid env entry");
      }
      if (loaderVariable(name)) continue;
      env[name] = text;
    }
    return env;
  }

  private snapshotOf(terminal: Terminal): TerminalSnapshot {
    return {
      terminalId: terminal.id,
      command: terminal.command,
      output: terminal.buffer.text(),
      truncated: terminal.buffer.truncated,
      totalBytes: terminal.buffer.totalBytes,
      exit: terminal.exit ?? null,
    };
  }

  private scheduleChange(terminal: Terminal): void {
    if (
      this.options.onChange === undefined ||
      terminal.changeTimer !== undefined ||
      terminal.released
    ) {
      return;
    }
    terminal.changeTimer = setTimeout(() => {
      terminal.changeTimer = undefined;
      if (terminal.released) return;
      this.options.onChange?.(this.snapshotOf(terminal));
    }, CHANGE_INTERVAL_MS);
    terminal.changeTimer.unref?.();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
