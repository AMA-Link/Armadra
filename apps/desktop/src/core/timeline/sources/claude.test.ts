import { describe, expect, it } from "vitest";

import { claudeAdapter } from "./claude";
import { convertAll, fixtureLines } from "./harness";

/**
 * 脱敏的 Claude 转录夹具 → 时间线。完整的条目序列固定在
 * `fixtures/claude/session.expected.json`（`vitest -u` 更新），下面的用例再逐类断言。
 */

const lines = fixtureLines("claude/session.jsonl");

describe("claude transcript → timeline", () => {
  const { items, head } = convertAll(claudeAdapter, lines);
  const byId = (id: string) => items.find((item) => item.id === id);

  it("matches the recorded conversion", async () => {
    await expect(
      JSON.stringify({ head, items }, null, 2) + "\n",
    ).toMatchFileSnapshot("./fixtures/claude/session.expected.json");
  });

  it("turns prompts into turns and skips machinery", () => {
    const users = items.filter((item) => item.kind === "user");
    expect(users.map((u) => (u.kind === "user" ? u.text : ""))).toEqual([
      "跑一下测试并修复",
      "再看一下 README",
      "好的，简短总结",
    ]);
    // 斜杠命令输出、队列记录、环境附件都不成条目。
    expect(items.some((item) => JSON.stringify(item).includes("ignored"))).toBe(
      false,
    );
    const turns = items.filter((item) => item.kind === "turn");
    expect(turns).toHaveLength(3);
    expect(
      turns.every((t) => t.kind === "turn" && t.endedAt !== undefined),
    ).toBe(true);
  });

  it("keeps a hidden thought as an empty, collapsed-by-default entry", () => {
    const thought = items.find((item) => item.kind === "thought");
    expect(thought).toMatchObject({ text: "", streaming: false });
  });

  it("maps Bash output into a terminal block with stdout and stderr", () => {
    const tool = byId("tool:toolu_bash1");
    expect(tool).toMatchObject({
      toolKind: "execute",
      status: "completed",
      title: "运行测试",
      input: { command: "pnpm test --run" },
    });
    const content = tool?.kind === "tool" ? tool.content : [];
    expect(content[0]).toMatchObject({
      type: "terminal",
      command: "pnpm test --run",
      output: "FAIL a.test.ts\n1 failed\nwarn: slow",
    });
  });

  it("turns a structured patch into a diff and a created file into an addition", () => {
    const edit = byId("tool:toolu_edit1");
    expect(edit?.kind === "tool" && edit.content[0]).toMatchObject({
      type: "diff",
      path: "/work/demo/src/a.ts",
      oldText: "export const a = 1;\nexport {};",
      newText: "export const a = 2;\nexport {};",
    });
    const write = byId("tool:toolu_write1");
    expect(write?.kind === "tool" && write.content[0]).toMatchObject({
      type: "diff",
      oldText: null,
      newText: "export const b = 1;\n",
    });
  });

  it("marks a failed command with its exit code", () => {
    const tool = byId("tool:toolu_bash2");
    expect(tool).toMatchObject({ status: "failed" });
    expect(tool?.kind === "tool" && tool.content[0]).toMatchObject({
      type: "terminal",
      exitCode: 1,
    });
  });

  it("turns TodoWrite into a plan, not a tool row", () => {
    expect(byId("tool:toolu_todo1")).toBeUndefined();
    const plan = items.find((item) => item.kind === "plan");
    expect(plan).toMatchObject({
      entries: [
        { content: "修复 a.ts", status: "in_progress" },
        { content: "重跑测试", status: "pending" },
      ],
    });
  });

  it("shows a sub-agent as one tool and skips its sidechain", () => {
    expect(byId("tool:toolu_task1")).toMatchObject({
      toolKind: "subagent",
      status: "completed",
    });
    expect(JSON.stringify(items)).not.toContain("子代理内部的话");
  });

  it("records usage, the agent title, the compaction notice and the image attachment", () => {
    expect(head.title).toBe("修复测试");
    expect(head.usage).toMatchObject({ used: 5210, size: 200000 });
    expect(items.find((item) => item.kind === "notice")).toMatchObject({
      code: "compacted",
    });
    const withImage = items.find(
      (item) => item.kind === "user" && item.attachments !== undefined,
    );
    expect(withImage).toMatchObject({
      attachments: [{ kind: "image", mimeType: "image/png" }],
    });
  });

  it("ends the turn as cancelled on an interrupt and with the stop reason otherwise", () => {
    const turns = items.filter((item) => item.kind === "turn");
    expect(turns.map((t) => (t.kind === "turn" ? t.stopReason : ""))).toEqual([
      "end_turn",
      "cancelled",
      "end_turn",
    ]);
    // 被打断时还没结果的提问工具记 cancelled。
    expect(byId("tool:toolu_ask1")).toMatchObject({ status: "cancelled" });
  });

  it("replaying the last batch after a crash adds nothing (ids come from the CLI)", () => {
    const tail = lines.slice(-8);
    const once = convertAll(claudeAdapter, lines);
    const again = convertAll(claudeAdapter, [...lines, ...tail]);
    expect(again.items.map((i) => i.id)).toEqual(once.items.map((i) => i.id));
  });
});
