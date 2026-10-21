import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { insertSession } from "../../hook/fixture";
import { normalizeAs } from "../../hook/normalize";
import { FakeTimers } from "../testing";
import { copilotToolKind, copilotTranscript } from "./copilot";
import { convertAll, fixtureLines, rig, type Rig } from "./harness";

/** 脱敏的 Copilot CLI `events.jsonl` 夹具 → 时间线；完整序列固定在 `fixtures/copilot/events.expected.json`。 */

const lines = fixtureLines("copilot/events.jsonl");

describe("copilot events → timeline", () => {
  const { items, head } = convertAll(copilotTranscript, lines);
  const byId = (id: string) => items.find((item) => item.id === id);

  it("matches the recorded conversion", async () => {
    await expect(
      JSON.stringify({ head, items }, null, 2) + "\n",
    ).toMatchFileSnapshot("./fixtures/copilot/events.expected.json");
  });

  it("opens turns from user messages and cancels on abort", () => {
    const users = items.filter((item) => item.kind === "user");
    expect(users.map((u) => (u.kind === "user" ? u.text : ""))).toEqual([
      "给 README 加一行并跑测试",
      "继续修复",
    ]);
    // 注入过上下文的版本不是用户说的话。
    expect(JSON.stringify(items)).not.toContain("<ctx>");
    const turns = items.filter((item) => item.kind === "turn");
    // Copilot 不写「回合完成」：第一个回合由下一条用户消息合上（不记原因），
    // 正常结束靠 agentStop 的 hook；被打断有 abort。
    expect(turns.map((t) => (t.kind === "turn" ? t.stopReason : ""))).toEqual([
      undefined,
      "cancelled",
    ]);
    expect(turns[0]).toMatchObject({ endedAt: expect.any(Number) });
  });

  it("reads reasoning text and assistant text, skipping sub-agent messages", () => {
    expect(byId("th:m1")).toMatchObject({
      kind: "thought",
      text: "先看 README。",
    });
    expect(byId("a:m2")).toMatchObject({
      kind: "assistant",
      parts: [{ type: "text", text: "改 README 并新建文件。" }],
    });
    expect(byId("a:m4")).toBeDefined();
    expect(JSON.stringify(items)).not.toContain("子代理内部的话");
    expect(byId("tool:call_inner")).toBeUndefined();
  });

  it("shows tools from the request on and hides report_intent", () => {
    expect(byId("tool:call_intent")).toBeUndefined();
    expect(byId("tool:call_view")).toMatchObject({
      toolKind: "read",
      status: "completed",
      locations: [{ path: "/work/demo/README.md" }],
    });
  });

  it("builds diffs from old_str / new_str and file_text", () => {
    const edit = byId("tool:call_edit");
    expect(edit).toMatchObject({ toolKind: "edit", status: "completed" });
    expect(edit?.kind === "tool" && edit.content).toMatchObject([
      {
        type: "diff",
        path: "/work/demo/README.md",
        oldText: "# Demo",
        newText: "# Demo\n新增一行",
      },
    ]);
    const create = byId("tool:call_create");
    expect(create?.kind === "tool" && create.content).toMatchObject([
      { type: "diff", oldText: null, newText: "hello" },
    ]);
  });

  it("reads bash output with the exit code from the trailer", () => {
    const ok = byId("tool:call_bash");
    expect(ok).toMatchObject({
      toolKind: "execute",
      status: "completed",
      title: "Run tests",
    });
    expect(ok?.kind === "tool" && ok.content[0]).toMatchObject({
      type: "terminal",
      command: "pnpm test",
      output: "2 passed",
      exitCode: 0,
    });
    const bad = byId("tool:call_bash2");
    expect(bad).toMatchObject({ status: "failed" });
    expect(bad?.kind === "tool" && bad.content[0]).toMatchObject({
      output: "1 problem",
      exitCode: 1,
    });
  });

  it("fails a tool that reports an error and keeps the message", () => {
    const task = byId("tool:call_task");
    expect(task).toMatchObject({ toolKind: "subagent", status: "failed" });
    expect(JSON.stringify(task)).toContain("子代理超时");
  });

  it("takes usage and window from usage_record and notes the compaction", () => {
    expect(head.usage).toEqual({ used: 25332, size: 128000 });
    expect(items.find((item) => item.kind === "notice")).toMatchObject({
      code: "compacted",
    });
  });

  it("classifies tool names", () => {
    expect(copilotToolKind("bash")).toBe("execute");
    expect(copilotToolKind("view")).toBe("read");
    expect(copilotToolKind("create")).toBe("edit");
    expect(copilotToolKind("sql")).toBe("other");
  });
});

describe("hook → events.jsonl → timeline", () => {
  const SESSION = "sess-cp";
  const COPILOT_SESSION = "11111111-2222-4333-8444-555555555555";
  let dir: string;
  let timers: FakeTimers;
  let r: Rig;
  let saved: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "armadra-cp-"));
    saved = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = dir;
    mkdirSync(join(dir, "session-state", COPILOT_SESSION), { recursive: true });
    timers = new FakeTimers();
    r = rig({ timers, watch: () => ({ close() {} }) });
    insertSession(r.fixture, {
      id: SESSION,
      status: "running",
      agentId: "copilot",
    });
  });

  afterEach(() => {
    r.close();
    if (saved === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  const hook = (payload: Record<string, unknown>) => {
    const event = normalizeAs("copilot", "copilot", r.fixture.nodeId, {
      sessionId: COPILOT_SESSION,
      ...payload,
    });
    if (event === undefined) throw new Error("not understood");
    r.domain.sources.onHook(r.fixture.nodeId, event);
  };

  it("finds the file by session id, tails it, and closes the turn on agentStop", () => {
    const file = join(dir, "session-state", COPILOT_SESSION, "events.jsonl");
    const ids = () => Object.keys(r.domain.writer.state(SESSION)?.items ?? {});
    writeFileSync(file, lines.slice(0, 6).join("\n") + "\n");
    hook({
      hookEventName: "userPromptSubmitted",
      prompt: "给 README 加一行并跑测试",
    });
    expect(r.domain.activity.get(SESSION)?.phase).toBe("submitting");
    timers.advance(400);
    expect(ids()).toContain("u:cp:00000000-0000-4000-8000-000000000005");

    appendFileSync(file, lines.slice(6, 12).join("\n") + "\n");
    hook({
      hookEventName: "postToolUse",
      toolName: "view",
      toolArgs: { path: "/work/demo/README.md" },
    });
    expect(r.domain.activity.get(SESSION)).toMatchObject({
      phase: "thinking",
    });
    timers.advance(400);
    expect(ids()).toContain("tool:call_view");

    appendFileSync(file, lines.slice(12, 17).join("\n") + "\n");
    hook({ hookEventName: "agentStop" });
    timers.advance(400);
    expect(ids()).toContain("tool:call_edit");
    expect(r.domain.activity.get(SESSION)).toMatchObject({ phase: "idle" });
    expect(
      Object.values(r.domain.writer.state(SESSION)?.items ?? {}).find(
        (item) => item.kind === "turn",
      ),
    ).toMatchObject({ stopReason: "end_turn" });
  });
});
