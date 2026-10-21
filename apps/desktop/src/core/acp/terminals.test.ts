import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AcpTerminals,
  type AcpTerminalsOptions,
  type TerminalSnapshot,
  isWithin,
} from "./terminals";

/**
 * 终端能力：真子进程（`node -e`），不依赖 shell 的行为差异。
 */

const SESSION = "s1";
const dirs: string[] = [];
const created: AcpTerminals[] = [];
const signal = new AbortController().signal;

afterEach(async () => {
  await Promise.all(created.splice(0).map((t) => t.dispose()));
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "armadra-term-"));
  dirs.push(dir);
  return dir;
}

function make(options: Partial<AcpTerminalsOptions> = {}) {
  const root = options.roots?.[0] ?? tempDir();
  const changes: TerminalSnapshot[] = [];
  const terminals = new AcpTerminals({
    roots: [root],
    sessionId: () => SESSION,
    authorize: () => true,
    onChange: (snapshot) => changes.push(snapshot),
    ...options,
  });
  created.push(terminals);
  const call = (method: string, params: Record<string, unknown> = {}) =>
    terminals.handle(method, { sessionId: SESSION, ...params }, signal);
  const run = async (
    code: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> => {
    const result = (await call("terminal/create", {
      command: process.execPath,
      args: ["-e", code],
      ...extra,
    })) as { terminalId: string };
    return result.terminalId;
  };
  return { terminals, root, changes, call, run };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function eventually(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("create → output → wait_for_exit", () => {
  it("输出与退出码；stdout 与 stderr 合在一起，退出后 output 带 exitStatus", async () => {
    const { call, run, changes } = make();
    const terminalId = await run(
      "console.log('out'); console.error('err'); process.exit(3)",
    );
    const exit = await call("terminal/wait_for_exit", { terminalId });
    expect(exit).toEqual({ exitCode: 3, signal: null });
    const result = (await call("terminal/output", { terminalId })) as {
      output: string;
      truncated: boolean;
      exitStatus?: unknown;
    };
    expect(result.output).toContain("out");
    expect(result.output).toContain("err");
    expect(result.truncated).toBe(false);
    expect(result.exitStatus).toEqual({ exitCode: 3, signal: null });
    // 退出时一定通知一次，带完整输出与退出码。
    const last = changes.at(-1) as TerminalSnapshot;
    expect(last.exit).toEqual({ exitCode: 3, signal: null });
    expect(last.output).toContain("out");
  });

  it("运行中 output 没有 exitStatus；输出变化被节流通知", async () => {
    const { call, run, changes } = make();
    const terminalId = await run(
      "console.log('first'); setTimeout(() => {}, 30000)",
    );
    await eventually(() => changes.some((c) => c.output.includes("first")));
    const result = (await call("terminal/output", { terminalId })) as {
      exitStatus?: unknown;
    };
    expect(result.exitStatus).toBeUndefined();
    expect(changes.every((c) => c.exit === null)).toBe(true);
  });

  it("整条命令行放在 command 里、没有 args：交给 shell 解析", async () => {
    const { call } = make();
    const created = (await call("terminal/create", {
      command: `${JSON.stringify(process.execPath)} -e "console.log('shell-ok')"`,
    })) as { terminalId: string };
    await call("terminal/wait_for_exit", { terminalId: created.terminalId });
    const result = (await call("terminal/output", {
      terminalId: created.terminalId,
    })) as { output: string };
    expect(result.output).toContain("shell-ok");
  });

  it("起不来的命令：退出码 127，输出里有原因", async () => {
    const { call } = make();
    const created = (await call("terminal/create", {
      command: "/nonexistent/armadra-command",
    })) as { terminalId: string };
    const exit = await call("terminal/wait_for_exit", {
      terminalId: created.terminalId,
    });
    expect(exit).toMatchObject({ exitCode: 127 });
  });
});

describe("输出上限", () => {
  it("只留尾部，在字符边界上切，truncated 为真", async () => {
    const { call, run } = make();
    const terminalId = await run(
      "process.stdout.write('头'.repeat(5000) + '尾巴')",
      { outputByteLimit: 1000 },
    );
    await call("terminal/wait_for_exit", { terminalId });
    const result = (await call("terminal/output", { terminalId })) as {
      output: string;
      truncated: boolean;
    };
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(1000);
    expect(result.output.endsWith("尾巴")).toBe(true);
    // 没有被切坏的半个字符。
    expect(result.output).not.toContain("�");
  });

  it("outputByteLimit 不能超过 core 的上限", async () => {
    const { call, run } = make({ outputLimit: 100 });
    const terminalId = await run("process.stdout.write('x'.repeat(5000))", {
      outputByteLimit: 10_000_000,
    });
    await call("terminal/wait_for_exit", { terminalId });
    const result = (await call("terminal/output", { terminalId })) as {
      output: string;
      truncated: boolean;
    };
    expect(result.output.length).toBe(100);
    expect(result.truncated).toBe(true);
  });
});

describe("cwd 限制", () => {
  it("缺省在会话 cwd；子目录可以；越界、符号链接逃逸都拒绝", async () => {
    const outside = tempDir();
    const { call, run, root } = make();
    mkdirSync(join(root, "sub"));
    symlinkSync(outside, join(root, "escape"));
    const here = await run("console.log(process.cwd())", { cwd: "sub" });
    await call("terminal/wait_for_exit", { terminalId: here });
    const result = (await call("terminal/output", { terminalId: here })) as {
      output: string;
    };
    expect(result.output.trim().endsWith("sub")).toBe(true);
    for (const cwd of [outside, "..", "escape", "escape/x", "/"]) {
      await expect(run("0", { cwd })).rejects.toMatchObject({ code: -32602 });
    }
  });

  it("isWithin：本身与内部算在内，兄弟目录前缀相同不算", () => {
    const base = tempDir();
    mkdirSync(join(base, "ws"));
    mkdirSync(join(base, "ws-other"));
    expect(isWithin(join(base, "ws"), join(base, "ws"))).toBe(true);
    expect(isWithin(join(base, "ws"), join(base, "ws", "a", "b"))).toBe(true);
    expect(isWithin(join(base, "ws"), join(base, "ws-other"))).toBe(false);
  });

  it("多个根：工作空间根下的 cwd 也允许", async () => {
    const second = tempDir();
    const { call, run } = make({ roots: [tempDir(), second] });
    const id = await run("console.log(process.cwd())", { cwd: second });
    await call("terminal/wait_for_exit", { terminalId: id });
    expect(
      (
        (await call("terminal/output", { terminalId: id })) as {
          output: string;
        }
      ).output.length,
    ).toBeGreaterThan(0);
  });
});

describe("拒绝与限额", () => {
  it("回合没在跑（authorize 为假）不开终端", async () => {
    const { run } = make({ authorize: () => false });
    await expect(run("0")).rejects.toMatchObject({ code: -32600 });
  });

  it("别的会话 id、还没开好的会话一律拒绝", async () => {
    const { terminals } = make();
    await expect(
      terminals.handle(
        "terminal/create",
        { sessionId: "other", command: "ls" },
        signal,
      ),
    ).rejects.toMatchObject({ code: -32602 });
    const unopened = make({ sessionId: () => undefined });
    await expect(unopened.run("0")).rejects.toMatchObject({ code: -32602 });
  });

  it("参数不合法：空命令、args 不是字符串数组、env 名字不合法", async () => {
    const { call } = make();
    await expect(
      call("terminal/create", { command: " " }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      call("terminal/create", { command: "x", args: [1] }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      call("terminal/create", {
        command: "x",
        env: [{ name: "a b", value: "1" }],
      }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      call("terminal/output", { terminalId: "nope" }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(call("terminal/bogus", {})).rejects.toMatchObject({
      code: -32601,
    });
  });

  it("同时存活的终端有上限，退出的不占", async () => {
    const { run, call } = make({ maxTerminals: 2 });
    const a = await run("setTimeout(() => {}, 30000)");
    await run("setTimeout(() => {}, 30000)");
    await expect(run("0")).rejects.toMatchObject({ code: -32600 });
    await call("terminal/kill", { terminalId: a });
    await call("terminal/wait_for_exit", { terminalId: a });
    await expect(run("0")).resolves.toBeTypeOf("string");
  });

  it("环境：Agent 给的叠在基础环境上，装载器变量丢掉", async () => {
    const { call, run } = make({
      env: { PATH: process.env.PATH, BASE_VAR: "base" },
    });
    const id = await run(
      "console.log([process.env.BASE_VAR, process.env.AGENT_VAR, process.env.LD_PRELOAD, process.env.DYLD_INSERT_LIBRARIES].join('|'))",
      {
        env: [
          { name: "AGENT_VAR", value: "agent" },
          { name: "LD_PRELOAD", value: "/evil.so" },
          { name: "DYLD_INSERT_LIBRARIES", value: "/evil.dylib" },
        ],
      },
    );
    await call("terminal/wait_for_exit", { terminalId: id });
    const out = (
      (await call("terminal/output", { terminalId: id })) as { output: string }
    ).output.trim();
    expect(out).toBe("base|agent||");
  });
});

describe("回收", () => {
  it("kill：SIGTERM 收掉整个进程组，退出信息带信号", async () => {
    const { call, run } = make();
    const id = await run(
      "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {stdio:'inherit'}); setTimeout(() => {}, 60000)",
    );
    await call("terminal/kill", { terminalId: id });
    const exit = (await call("terminal/wait_for_exit", { terminalId: id })) as {
      signal: string | null;
    };
    expect(exit.signal).toBe("SIGTERM");
    // kill 之后终端仍在：能取输出。
    await expect(
      call("terminal/output", { terminalId: id }),
    ).resolves.toBeTruthy();
  });

  it("release：还在跑的被杀掉，终端 id 随即失效，最后一次输出先通知", async () => {
    const { call, run, terminals, changes } = make();
    const id = await run("console.log('bye'); setTimeout(() => {}, 60000)");
    await eventually(
      () => terminals.snapshot(id)?.output.includes("bye") === true,
    );
    const [pid] = terminals.pids;
    expect(alive(pid as number)).toBe(true);
    await call("terminal/release", { terminalId: id });
    expect(changes.at(-1)?.output).toContain("bye");
    await expect(
      call("terminal/output", { terminalId: id }),
    ).rejects.toMatchObject({ code: -32602 });
    await eventually(() => !alive(pid as number));
  });

  it("dispose：会话结束时所有还活着的子进程（含孙进程）都收掉，之后不再开", async () => {
    const { run, terminals } = make();
    await run("setTimeout(() => {}, 60000)");
    await run(
      "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {stdio:'inherit'}); console.log('grandchild ' + c.pid); setTimeout(() => {}, 60000)",
    );
    const pids = terminals.pids;
    expect(pids).toHaveLength(2);
    await terminals.dispose();
    for (const pid of pids) expect(alive(pid)).toBe(false);
    expect(terminals.pids).toEqual([]);
    await expect(run("0")).rejects.toMatchObject({ code: -32600 });
  });

  it("wait_for_exit 在连接关闭（signal abort）时以取消失败", async () => {
    const { terminals, run } = make();
    const id = await run("setTimeout(() => {}, 60000)");
    const controller = new AbortController();
    const waiting = terminals.handle(
      "terminal/wait_for_exit",
      { sessionId: SESSION, terminalId: id },
      controller.signal,
    );
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: -32800 });
  });
});
