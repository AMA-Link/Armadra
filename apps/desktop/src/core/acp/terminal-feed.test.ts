import { describe, expect, it } from "vitest";

import { TerminalFeedLink } from "./terminal-feed";
import type { TerminalSnapshot } from "./terminals";

function snap(
  terminalId: string,
  output: string,
  exit: TerminalSnapshot["exit"] = null,
  extra: Partial<TerminalSnapshot> = {},
): TerminalSnapshot {
  return {
    terminalId,
    command: "pnpm test",
    output,
    truncated: false,
    totalBytes: output.length,
    exit,
    ...extra,
  };
}

const toolCall = (content: unknown[], extra: object = {}) => ({
  sessionUpdate: "tool_call",
  toolCallId: "c1",
  title: "Run",
  kind: "execute",
  status: "in_progress",
  content,
  ...extra,
});

describe("TerminalFeedLink", () => {
  it("不带终端内容的更新原样返回", () => {
    const link = new TerminalFeedLink(() => undefined);
    const message = { sessionUpdate: "agent_message_chunk", content: {} };
    expect(link.decorate(message)).toBe(message);
    const plain = toolCall([
      { type: "content", content: { type: "text", text: "x" } },
    ]);
    expect(link.decorate(plain)).toBe(plain);
  });

  it("挂上终端的工具更新补上此刻的输出与退出码", () => {
    const link = new TerminalFeedLink((id) =>
      id === "t1"
        ? snap("t1", "hello", { exitCode: 0, signal: null })
        : undefined,
    );
    const decorated = link.decorate(
      toolCall([{ type: "terminal", terminalId: "t1" }]),
    ) as {
      content: unknown[];
    };
    expect(decorated.content).toEqual([
      {
        type: "terminal",
        terminalId: "t1",
        command: "pnpm test",
        output: "hello",
        exitCode: 0,
      },
    ]);
  });

  it("终端变了合成 tool_call_update；Agent 之后再发只有 terminalId 的更新，输出不被冲掉", () => {
    let live: TerminalSnapshot | undefined = snap("t1", "");
    const link = new TerminalFeedLink(() => live);
    link.decorate(
      toolCall([
        { type: "content", content: { type: "text", text: "note" } },
        { type: "terminal", terminalId: "t1" },
      ]),
    );
    const update = link.updateFor(snap("t1", "line 1\n"));
    expect(update).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      content: [
        { type: "content", content: { type: "text", text: "note" } },
        {
          type: "terminal",
          terminalId: "t1",
          command: "pnpm test",
          output: "line 1\n",
        },
      ],
    });
    // 终端已释放：lookup 找不到，用最后一次记下的样子。
    link.updateFor(snap("t1", "done\n", { exitCode: 1, signal: null }));
    live = undefined;
    const later = link.decorate({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      status: "failed",
      content: [{ type: "terminal", terminalId: "t1" }],
    }) as { content: Array<Record<string, unknown>>; status: string };
    expect(later.status).toBe("failed");
    expect(later.content[0]).toMatchObject({ output: "done\n", exitCode: 1 });
  });

  it("被信号杀掉记 exitCode null；丢过头部带 truncated 与总字节数", () => {
    const link = new TerminalFeedLink(() => undefined);
    link.decorate(toolCall([{ type: "terminal", terminalId: "t1" }]));
    const update = link.updateFor(
      snap(
        "t1",
        "tail",
        { exitCode: null, signal: "SIGTERM" },
        { truncated: true, totalBytes: 999 },
      ),
    ) as { content: Array<Record<string, unknown>> };
    expect(update.content[0]).toMatchObject({
      exitCode: null,
      truncated: true,
      originalBytes: 999,
    });
  });

  it("还没挂到任何工具的终端不合成更新，挂上时补最后一次的样子", () => {
    const link = new TerminalFeedLink(() => undefined);
    expect(link.updateFor(snap("t9", "early"))).toBeUndefined();
    const decorated = link.decorate(
      toolCall([{ type: "terminal", terminalId: "t9" }]),
    ) as {
      content: Array<Record<string, unknown>>;
    };
    expect(decorated.content[0]).toMatchObject({ output: "early" });
  });

  it("记忆有上限：太多终端之后最旧的被忘掉", () => {
    const link = new TerminalFeedLink(() => undefined);
    for (let i = 0; i < 100; i++) {
      link.decorate(
        toolCall([{ type: "terminal", terminalId: `t${i}` }], {
          toolCallId: `c${i}`,
        }),
      );
    }
    expect(link.updateFor(snap("t0", "x"))).toBeUndefined();
    expect(link.updateFor(snap("t99", "x"))).toBeDefined();
  });
});
