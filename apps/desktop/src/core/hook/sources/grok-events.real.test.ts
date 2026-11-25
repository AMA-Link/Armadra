import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { markChannelUnbound } from "../../agent/state-source";
import type { StateSlotContext } from "../../timeline/sources/state-slot";
import { realTailTimers } from "../../timeline/sources/tailer";
import type { AgentEvent } from "../normalize/event";
import { grokSlotProvider } from "./grok-events";

/**
 * 真 grok、真账号、真 tmux 的状态读取槽验收（场景「grok 状态源」，契约 §121）。
 *
 * 默认跳过：它会起真的 `grok`，用本机已有的登录态发三个极短回合，会话留在
 * `~/.grok/sessions` 里（不删）。要跑：`ARMADRA_REAL_GROK=1 pnpm --filter
 * @armadra/desktop exec vitest run src/core/hook/sources/grok-events.real.test.ts`。
 *
 * 不碰凭据（只读 `active_sessions.json` 里本进程的行与会话自己的 `events.jsonl`），
 * 只杀自己起的 tmux 服务器；工作目录是一个不在任何 git 仓库里的临时目录。
 */

const REAL = process.env.ARMADRA_REAL_GROK === "1";
const SOCKET = join(tmpdir(), `armadra-real-grok-${process.pid}.sock`);
const run = (args: string[]) =>
  spawnSync("tmux", ["-S", SOCKET, "-f", "/dev/null", ...args], {
    encoding: "utf8",
  });

function grokBinary(): string {
  const found = execFileSync("sh", ["-c", "command -v grok"], {
    encoding: "utf8",
  }).trim();
  return realpathSync(found);
}

async function until(
  ready: () => boolean,
  what: string,
  ms = 60_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`never became true: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe.skipIf(!REAL)("真 grok 的状态读取槽", () => {
  // 一个已经被用户信任过的目录（`ARMADRA_REAL_GROK_DIR`），否则 grok 会先弹目录信任
  // 框：回答它会往用户真实的 `trusted_folders.toml` 写一条，这个测试不替人答。
  const trusted = process.env.ARMADRA_REAL_GROK_DIR;
  const work =
    trusted ?? mkdtempSync(join(realpathSync(tmpdir()), "armadra-grok-real-"));
  afterAll(() => {
    run(["kill-server"]);
    if (trusted === undefined) rmSync(work, { recursive: true, force: true });
  });

  it("工作 → 完成、/new 换会话、自动放行不报 waiting、审批报 waiting", async () => {
    const created = run([
      "new-session",
      "-d",
      "-s",
      "g",
      "-x",
      "120",
      "-y",
      "40",
      "-c",
      work,
      `${grokBinary()} --no-memory --permission-mode default --allow 'Bash(echo *)'`,
    ]);
    expect(created.status, created.stderr).toBe(0);
    const pid = Number(
      run(["list-panes", "-t", "g", "-F", "#{pane_pid}"]).stdout,
    );
    const reports: AgentEvent[] = [];
    const context: StateSlotContext = {
      nodeId: "real-node",
      workspaceId: "ws",
      agentId: "grok",
      sessionId: "t",
      generation: 1,
      cwd: work,
      startedAtMs: 0,
      pid: () => pid,
      remote: () => false,
      report: (event) => {
        reports.push({ ...event });
        return true;
      },
      timers: realTailTimers,
      log: { warn: () => undefined, debug: () => undefined },
    };
    const slot = grokSlotProvider().open(context);
    expect(slot).toBeDefined();
    slot!.start();
    const states = () =>
      reports.filter((e) => e.kind === "state").map((e) => e.state);
    const type = (text: string) => run(["send-keys", "-t", "g", text, "Enter"]);
    try {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      const screen = run(["capture-pane", "-p", "-t", "g"]).stdout;
      if (/Do you trust the contents of this directory\?/.test(screen)) {
        // 信任框回归：框还在时 grok 没有打开会话，没有行、也就没有任何上报；
        // 画面门的 `grok.folder-trust` 在投递一侧拦（screen-gate.test.ts）。
        expect(reports).toEqual([]);
        console.warn("目录没有被信任过：只验了「信任框期间不上报」");
        return;
      }
      // 起来：会话行出现，说一次 session start，还没有任何回合。
      await until(
        () => reports.some((e) => e.kind === "session"),
        "session start",
        30_000,
      );
      expect(states()).toEqual([]);

      // 回合 1：working → done。
      type("Reply with only the word ok.");
      await until(() => states().includes("done"), "turn 1 done");
      expect(states()).toEqual(["working", "done"]);
      expect(reports.find((e) => e.state === "working")?.newTurn).toBe(true);

      // /new：同一个进程里第二个会话，旧行还在；回合 2 用 --allow 放行的命令。
      reports.length = 0;
      type("/new");
      await until(
        () => reports.filter((e) => e.kind === "session").length === 1,
        "second session start",
      );
      type(
        "Use your shell tool (run_terminal_command) to run: echo hi. You must call the tool. Then say done.",
      );
      await until(() => states().includes("done"), "turn 2 done");
      expect(states()).not.toContain("waiting");

      // 回合 3：需要审批的命令（不在 --allow 里）：窗口过后报 waiting，拒绝它。
      reports.length = 0;
      // 注意：裸 `touch` / `mkdir` 属于 grok 的「只读」命令，不会弹审批；写文件的 `sh -c` 会。
      type(
        'Use your shell tool to run exactly: sh -c "echo x > armadra-real-probe.txt". You must call the tool.',
      );
      await until(() => states().includes("waiting"), "waiting on approval");
      run(["send-keys", "-t", "g", "4"]);
      await until(() => states().at(-1) === "done", "done after reject");
      const last = reports.at(-1)!;
      expect(last.interrupted).toBe(true);
      expect(last.stateSource).toBe("transcript");
    } finally {
      slot!.stop();
      markChannelUnbound("real-node", false);
      type("/quit");
    }
  }, 300_000);
});
