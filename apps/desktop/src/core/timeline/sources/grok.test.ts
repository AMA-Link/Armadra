import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { insertSession } from "../../hook/fixture";
import { sessionEvent } from "../../hook/normalize/event";
import { FakeTimers } from "../testing";

import { type Rig, convertAll, fixtureLines, rig } from "./harness";
import { ADAPTERS } from "./index";
import { grokTranscript } from "./grok";

/**
 * 合成的 Grok 会话文件（形状取自 1.0.92 的 `updates.jsonl`，内容是编的）→ 时间线。
 * 完整条目序列固定在 `fixtures/grok/session.expected.json`（`vitest -u` 更新）。
 */

const lines = fixtureLines("grok/session.jsonl");

describe("grok transcript → timeline", () => {
  const { items, head } = convertAll(grokTranscript, lines);
  const byId = (id: string) => items.find((item) => item.id === id);

  it("matches the recorded conversion", async () => {
    await expect(
      JSON.stringify({ head, items }, null, 2) + "\n",
    ).toMatchFileSnapshot("./fixtures/grok/session.expected.json");
  });

  it("is registered under the base agent id", () => {
    expect(ADAPTERS.grok).toBe(grokTranscript);
  });

  it("a second session: a divider notice, ids from _meta.eventId, no stray close", () => {
    const turns = items.filter((item) => item.kind === "turn");
    expect(turns).toHaveLength(3);
    const second = turns[2];
    expect(second?.kind === "turn" && second.stopReason).toBe("end_turn");
    // 另一个会话的 turn_completed 夹在中间，没有把这边的回合收掉：它的收尾在最后一行。
    expect(second?.kind === "turn" && second.endedAt).toBe(1795584104000);
    const notice = items.find((item) => item.kind === "notice");
    expect(notice).toMatchObject({
      code: "info",
      params: { name: "00000000" },
    });
    expect(items.map((item) => item.id)).toContain(
      "a:00000000-0000-7000-8000-00000000g002-6",
    );
    // 没有 timestamp_us 与 _meta 的老行：id 取内容摘要、时间取 timestamp 秒。
    const old = items.find(
      (item) =>
        item.kind === "assistant" &&
        JSON.stringify(item.parts).includes("Old-shape"),
    );
    expect(old?.id).toMatch(/^a:[0-9a-f]{16}$/);
    expect(old?.at).toBe(1795584103000);
  });

  it("turns prompts into turns, closes them on turn_completed", () => {
    const users = items.filter((item) => item.kind === "user");
    expect(users.map((u) => (u.kind === "user" ? u.text : ""))).toEqual([
      "Add a greeting file and run it",
      "Now stop",
      "Second session question",
    ]);
    const turns = items.filter((item) => item.kind === "turn");
    expect(
      turns.slice(0, 2).map((t) => (t.kind === "turn" ? t.stopReason : "")),
    ).toEqual(["end_turn", "cancelled"]);
  });

  it("skips machinery: hooks, mode updates, unknown updates and foreign rows", () => {
    expect(items.some((item) => JSON.stringify(item).includes("future"))).toBe(
      false,
    );
    expect(items.some((item) => JSON.stringify(item).includes("hook"))).toBe(
      false,
    );
  });

  it("keeps thoughts and assistant text", () => {
    expect(items.filter((item) => item.kind === "thought")).toHaveLength(1);
    expect(
      items
        .filter((item) => item.kind === "assistant")
        .map((item) => JSON.stringify(item.parts)),
    ).toHaveLength(5);
  });

  it("maps a command into a terminal block with output and exit code", () => {
    const tool = byId("tool:call-a-1");
    expect(tool).toMatchObject({ toolKind: "execute", status: "completed" });
    const content = tool?.kind === "tool" ? tool.content : [];
    expect(content[0]).toMatchObject({
      type: "terminal",
      command: "cat hello.txt",
      output: "hello\n",
      exitCode: 0,
    });
  });

  it("marks a non-zero exit as failed", () => {
    expect(byId("tool:call-a-2")).toMatchObject({ status: "failed" });
  });

  it("turns an edit into a diff of an added file", () => {
    const edit = byId("tool:call-a-0");
    expect(edit).toMatchObject({ toolKind: "edit", status: "completed" });
    expect(edit?.kind === "tool" && edit.content[0]).toMatchObject({
      type: "diff",
      path: "/work/hello.txt",
      oldText: null,
      newText: "hello\n",
    });
  });

  it("classifies a listing as a read", () => {
    expect(byId("tool:call-a-3")).toMatchObject({ toolKind: "read" });
  });

  it("re-reading the whole file writes the same items (ids are stable)", () => {
    const again = convertAll(grokTranscript, [...lines, ...lines]);
    expect(again.items.map((item) => item.id)).toEqual(
      items.map((item) => item.id),
    );
  });

  it("never throws on records of a shape it does not know", () => {
    const { items: odd } = convertAll(grokTranscript, [
      "[]",
      "1",
      '{"params":{"update":{"sessionUpdate":"tool_call_update"}}}',
      '{"params":{"update":{"sessionUpdate":"user_message_chunk","content":5}}}',
      '{"params":{"update":{"sessionUpdate":"turn_completed","stop_reason":{"x":1}}}}',
    ]);
    expect(odd).toEqual([]);
  });
});

describe("grok transcript through the source manager", () => {
  const SESSION = "term-1";
  let dir: string;
  let timers: FakeTimers;
  let r: Rig;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "armadra-test-grok-"));
    timers = new FakeTimers();
    r = rig({ timers, watch: () => ({ close() {} }) });
  });
  afterEach(() => {
    r.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const file = (id: string, from: number, to: number) => {
    mkdirSync(join(dir, id), { recursive: true });
    const path = join(dir, id, "updates.jsonl");
    writeFileSync(path, lines.slice(from, to).join("\n") + "\n");
    return path;
  };
  const start = (transcriptPath: string) => {
    const event = sessionEvent(r.fixture.nodeId, "grok", "start");
    event.transcriptPath = transcriptPath;
    r.domain.sources.onHook(r.fixture.nodeId, event);
  };
  const ids = () => Object.keys(r.domain.writer.state(SESSION)?.items ?? {});

  it("reads the reported file, then follows /new to the next session's file", () => {
    insertSession(r.fixture, {
      id: SESSION,
      status: "running",
      agentId: "grok",
    });
    start(file("one", 0, 8));
    timers.advance(200);
    expect(ids()).toContain("tool:call-a-0");
    expect(ids().some((id) => id.startsWith("turn:gk:"))).toBe(true);
    // `/new`：新会话的文件换了路径，来源重新定位，旧会话的条目留着。
    const before = ids();
    start(file("two", 22, 27));
    timers.advance(400);
    expect(ids().length).toBeGreaterThan(before.length);
    for (const id of before) expect(ids()).toContain(id);
  });

  it("ignores a reported path that is not an updates.jsonl", () => {
    insertSession(r.fixture, {
      id: SESSION,
      status: "running",
      agentId: "grok",
    });
    const stray = join(dir, "events.jsonl");
    writeFileSync(stray, lines.slice(0, 8).join("\n") + "\n");
    start(stray);
    timers.advance(400);
    expect(ids()).toEqual([]);
  });

  it("follows a session whose file appears after the report", () => {
    insertSession(r.fixture, {
      id: SESSION,
      status: "running",
      agentId: "grok",
    });
    start(file("one", 0, 8));
    timers.advance(200);
    // `updates.jsonl` 比 `events.jsonl` 晚一百多毫秒才建：路径先报、文件后到。
    const later = join(dir, "two", "updates.jsonl");
    start(later);
    timers.advance(300);
    expect(ids().some((id) => id.includes("g002"))).toBe(false);
    mkdirSync(join(dir, "two"), { recursive: true });
    writeFileSync(later, lines.slice(22, 27).join("\n") + "\n");
    timers.advance(1_500);
    expect(ids().some((id) => id.includes("g002"))).toBe(true);
  });

  it("does not attach to an ACP-driven session: the ACP driver writes its own timeline", () => {
    insertSession(r.fixture, {
      id: SESSION,
      status: "running",
      agentId: "grok",
    });
    r.database
      .prepare("UPDATE terminal_sessions SET backend_kind = 'acp' WHERE id = ?")
      .run(SESSION);
    start(file("one", 0, 8));
    timers.advance(400);
    expect(ids()).toEqual([]);
    expect(r.domain.store.get(SESSION)?.source).not.toBe("transcript");
  });
});
