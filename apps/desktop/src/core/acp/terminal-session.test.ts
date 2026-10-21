import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { TimelineItem } from "@armadra/shared";

import type { WorkspaceEvent } from "../bus";
import { type TimelineDomain, install as installTimeline } from "../timeline";
import { type AcpCore, FAKE_AGENT, acpCore, until } from "./fixture";

/**
 * B9：Agent 经 `terminal/*` 在 core 里跑命令（假 Agent 是真子进程，见
 * `terminal-agent.fixture.mjs`）。整条链路：声明能力 → create → 输出流进时间线
 * 工具行 → wait_for_exit / output / release → 会话结束回收子进程。
 */

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "terminal-agent.fixture.mjs",
);

let open: AcpCore | undefined;
let domain: TimelineDomain;
let seen: WorkspaceEvent[];

afterEach(async () => {
  await open?.stop();
  open = undefined;
});

async function boot(): Promise<void> {
  open = await acpCore({ script: SCRIPT });
  domain = installTimeline(open.core) as TimelineDomain;
  seen = [];
  open.core.bus.on("workspace.event", ({ event }) => seen.push(event));
}

async function start(prompt: string, permissionMode?: string) {
  const nodeId = await open!.node();
  const created = await open!.core.call("POST", "/api/acp/sessions", {
    workspaceId: open!.workspaceId,
    nodeId,
    cwd: open!.core.directory,
    agentId: FAKE_AGENT,
    prompt,
    ...(permissionMode === undefined ? {} : { permissionMode }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return { nodeId, rowId: (created.body as { id: string }).id };
}

function items(rowId: string): TimelineItem[] {
  domain.writer.flush();
  return domain.store.snapshot(rowId, 20)?.items ?? [];
}

const turnsEnded = () => seen.filter((event) => event.type === "acp.turn");

const assistantText = (rowId: string): string =>
  JSON.stringify(items(rowId).filter((i) => i.kind === "assistant"));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("terminal/*", () => {
  it("声明 terminal 能力", async () => {
    await boot();
    const { rowId } = await start("[caps]");
    await until(turnsEnded, (turns) => turns.length > 0);
    expect(assistantText(rowId)).toContain("caps:true");
  });

  it("create → 输出流 → wait_for_exit：时间线工具行带输出尾部与退出码，release 之后也不丢", async () => {
    await boot();
    const { rowId } = await start("[term]");
    await until(turnsEnded, (turns) => turns.length > 0);
    // Agent 看到的结果。
    const text = assistantText(rowId);
    expect(text).toContain('exit:{\\"exitCode\\":5,\\"signal\\":null}');
    expect(text).toContain("line one");
    expect(text).toContain("line two");
    // 时间线：工具行上有终端内容。
    const tool = items(rowId).find((i) => i.kind === "tool");
    expect(tool).toMatchObject({
      toolCallId: "tc-1",
      status: "failed",
      content: [
        {
          type: "terminal",
          exitCode: 5,
          output: expect.stringContaining("line two"),
        },
      ],
    });
    // 旧的 acp.update 路径不带终端内容。
    const legacy = seen.filter(
      (event) =>
        event.type === "acp.update" &&
        String(
          (event.update as { sessionUpdate: string }).sessionUpdate,
        ).startsWith("tool_call"),
    );
    expect(legacy).toHaveLength(2);
    expect(JSON.stringify(legacy)).not.toContain('"output"');
  });

  it("输出是实时的：命令还在跑时工具行已经有第一行", async () => {
    await boot();
    const { rowId } = await start("[term]");
    const early = await until(
      () =>
        items(rowId).find((i) => i.kind === "tool") as
          | { content: Array<{ output?: string; exitCode?: number | null }> }
          | undefined,
      (tool) =>
        tool?.content[0]?.output?.includes("line one") === true &&
        tool.content[0].exitCode === undefined,
    );
    expect(early?.content[0]?.output).not.toContain("line two");
    await until(turnsEnded, (turns) => turns.length > 0);
  });

  it("工作空间之外的 cwd 被拒绝，Agent 拿到 invalid params", async () => {
    await boot();
    const { rowId } = await start("[term-escape]");
    await until(turnsEnded, (turns) => turns.length > 0);
    expect(assistantText(rowId)).toContain("escape:-32602");
  });

  it("只读模式不给终端：Agent 的请求被拒绝", async () => {
    await boot();
    const { rowId } = await start("[term-escape]", "plan");
    await until(turnsEnded, (turns) => turns.length > 0);
    expect(assistantText(rowId)).toContain("escape:-32601");
  });

  const unix = process.platform !== "win32";
  (unix ? it : it.skip)(
    "会话结束时没 release 的子进程也被收掉（按 pid）",
    async () => {
      await boot();
      const { rowId } = await start("[term-hang]");
      await until(turnsEnded, (turns) => turns.length > 0);
      const pidFile = join(open!.core.directory, "hang.pid");
      await until(
        () => existsSync(pidFile),
        (ready) => ready,
      );
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(alive(pid)).toBe(true);
      // 工具行此刻还在跑：有终端内容，没有退出码。
      expect(items(rowId).find((i) => i.kind === "tool")).toMatchObject({
        content: [{ type: "terminal" }],
      });
      await open!.stop();
      open = undefined;
      await until(
        () => alive(pid),
        (running) => !running,
      );
    },
  );
});
