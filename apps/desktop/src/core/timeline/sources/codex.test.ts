import { describe, expect, it } from "vitest";

import { codexAdapter } from "./codex";
import { convertAll, fixtureLines } from "./harness";

/** 脱敏的 Codex rollout 夹具 → 时间线；完整序列固定在 `fixtures/codex/rollout.expected.json`。 */

const lines = fixtureLines("codex/rollout.jsonl");

describe("codex rollout → timeline", () => {
  const { items, head } = convertAll(codexAdapter, lines);
  const byId = (id: string) => items.find((item) => item.id === id);

  it("matches the recorded conversion", async () => {
    await expect(
      JSON.stringify({ head, items }, null, 2) + "\n",
    ).toMatchFileSnapshot("./fixtures/codex/rollout.expected.json");
  });

  it("opens turns from task_started and keeps injected context out", () => {
    const turns = items.filter((item) => item.kind === "turn");
    expect(turns.map((t) => (t.kind === "turn" ? t.stopReason : ""))).toEqual([
      "end_turn",
      "cancelled",
    ]);
    const users = items.filter((item) => item.kind === "user");
    expect(users.map((u) => (u.kind === "user" ? u.text : ""))).toEqual([
      "给 README 加一行并跑测试",
      "继续修复",
    ]);
    expect(JSON.stringify(items)).not.toContain("app-context");
    expect(JSON.stringify(items)).not.toContain("AGENTS.md");
  });

  it("keeps reasoning summaries and drops the encrypted-only ones", () => {
    const thoughts = items.filter((item) => item.kind === "thought");
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0]).toMatchObject({ text: "先看 README，再补一行。" });
  });

  it("reads a command and its JSON-wrapped output", () => {
    expect(byId("tool:call_1")).toMatchObject({
      toolKind: "execute",
      status: "completed",
      title: "cat README.md",
    });
    const tool = byId("tool:call_1");
    expect(tool?.kind === "tool" && tool.content[0]).toMatchObject({
      type: "terminal",
      output: "# Demo\n",
      exitCode: 0,
    });
  });

  it("parses apply_patch into one diff per file", () => {
    const tool = byId("tool:call_2");
    expect(tool).toMatchObject({
      toolKind: "edit",
      status: "completed",
      title: "Edit README.md, notes.txt",
      locations: [{ path: "README.md" }, { path: "notes.txt" }],
    });
    const content = tool?.kind === "tool" ? tool.content : [];
    expect(content).toMatchObject([
      {
        type: "diff",
        path: "README.md",
        oldText: "# Demo",
        newText: "# Demo\n新增一行",
      },
      { type: "diff", path: "notes.txt", oldText: null, newText: "hello" },
    ]);
  });

  it("turns update_plan into a plan", () => {
    expect(byId("tool:call_3")).toBeUndefined();
    expect(items.find((item) => item.kind === "plan")).toMatchObject({
      entries: [
        { content: "补 README", status: "completed" },
        { content: "跑测试", status: "in_progress" },
      ],
    });
  });

  it("takes the command out of a bash -lc array and fails a non-zero exit", () => {
    const tool = byId("tool:call_4");
    expect(tool).toMatchObject({
      title: "pnpm test",
      status: "failed",
    });
    expect(tool?.kind === "tool" && tool.content[0]).toMatchObject({
      type: "terminal",
      command: "pnpm test",
      output: "1 failed\n",
      exitCode: 1,
    });
  });

  it("handles local_shell_call and a bare JSON output", () => {
    expect(byId("tool:call_5")).toMatchObject({
      title: "git status",
      status: "completed",
    });
  });

  it("records usage from token_count", () => {
    expect(head.usage).toEqual({ used: 4200, size: 258400 });
  });
});
