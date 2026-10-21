import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { insertSession } from "../../hook/fixture";
import { normalizeAs } from "../../hook/normalize";
import { FakeTimers } from "../testing";
import { convertAll, rig, type Rig } from "./harness";
import { opencodeTranscript } from "./opencode";
import { FIRST_MESSAGES, readOpencode, sessionOf } from "./opencode-db";

/** 脱敏的 OpenCode 会话（`fixtures/opencode/session.json`）→ 临时库 → 读取 → 时间线。 */

const here = dirname(fileURLToPath(import.meta.url));

interface Fixture {
  session: {
    id: string;
    title: string;
    directory: string;
    time_updated: number;
  };
  messages: {
    id: string;
    time_created: number;
    time_updated: number;
    data: unknown;
  }[];
  parts: {
    id: string;
    message_id: string;
    time_created: number;
    time_updated: number;
    data: unknown;
  }[];
}

const fixture = JSON.parse(
  readFileSync(join(here, "fixtures/opencode/session.json"), "utf8"),
) as Fixture;
const SID = fixture.session.id;

function createSchema(database: DatabaseSync): void {
  database.exec(
    "CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);" +
      "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);" +
      "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);",
  );
}

function insert(
  database: DatabaseSync,
  fx: Fixture,
  filter: (id: string) => boolean = () => true,
): void {
  database
    .prepare("INSERT OR REPLACE INTO session VALUES (?, NULL, ?, ?, ?, ?)")
    .run(
      fx.session.id,
      fx.session.directory,
      fx.session.title,
      fx.session.time_updated,
      fx.session.time_updated,
    );
  for (const m of fx.messages) {
    if (!filter(m.id)) continue;
    database
      .prepare("INSERT OR REPLACE INTO message VALUES (?, ?, ?, ?, ?)")
      .run(m.id, SID, m.time_created, m.time_updated, JSON.stringify(m.data));
  }
  for (const p of fx.parts) {
    if (!filter(p.message_id)) continue;
    database
      .prepare("INSERT OR REPLACE INTO part VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        p.id,
        p.message_id,
        SID,
        p.time_created,
        p.time_updated,
        JSON.stringify(p.data),
      );
  }
}

function memoryDb(filter?: (id: string) => boolean): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  createSchema(database);
  insert(database, fixture, filter);
  return database;
}

describe("opencode database → timeline", () => {
  const database = memoryDb();
  const first = readOpencode(database, SID, undefined);
  const { items, head } = convertAll(opencodeTranscript, first.lines);
  const byId = (id: string) => items.find((item) => item.id === id);

  it("matches the recorded conversion", async () => {
    await expect(
      JSON.stringify({ head, items }, null, 2) + "\n",
    ).toMatchFileSnapshot("./fixtures/opencode/session.expected.json");
  });

  it("opens turns on user text and ends them from finish / abort", () => {
    const users = items.filter((item) => item.kind === "user");
    expect(users.map((u) => (u.kind === "user" ? u.text : ""))).toEqual([
      "给 README 加一行并跑测试",
      "继续修复",
    ]);
    expect(JSON.stringify(items)).not.toContain("background-task");
    const turns = items.filter((item) => item.kind === "turn");
    expect(turns.map((t) => (t.kind === "turn" ? t.stopReason : ""))).toEqual([
      "end_turn",
      "cancelled",
    ]);
  });

  it("keeps finished text, an empty hidden thought, and skips streaming text", () => {
    expect(byId("a:prt_02c")).toMatchObject({
      kind: "assistant",
      parts: [{ type: "text", text: "先看 README，再补一行。" }],
    });
    expect(byId("th:prt_02b")).toMatchObject({ kind: "thought", text: "" });
    // 还在写的文本（没有 time.end）不落库。
    expect(byId("a:prt_05a")).toBeUndefined();
  });

  it("reads tools with their states, diffs and terminal output", () => {
    expect(byId("tool:call_read")).toMatchObject({
      toolKind: "read",
      status: "completed",
      locations: [{ path: "/work/demo/README.md" }],
    });
    const edit = byId("tool:call_edit");
    expect(edit?.kind === "tool" && edit.content).toMatchObject([
      {
        type: "diff",
        path: "/work/demo/README.md",
        oldText: "# Demo",
        newText: "# Demo\n新增一行",
      },
    ]);
    // 入参没有 oldString / newString 时退到 filediff.patch。
    const patched = byId("tool:call_edit2");
    expect(patched?.kind === "tool" && patched.content).toMatchObject([
      {
        type: "diff",
        path: "/work/demo/notes.txt",
        oldText: "keep\nold line",
        newText: "keep\nnew line",
      },
    ]);
    const write = byId("tool:call_write");
    expect(write?.kind === "tool" && write.content).toMatchObject([
      { type: "diff", oldText: null, newText: "hello" },
    ]);
    const ok = byId("tool:call_bash");
    expect(ok).toMatchObject({ toolKind: "execute", status: "completed" });
    expect(ok?.kind === "tool" && ok.content[0]).toMatchObject({
      type: "terminal",
      command: "pnpm test",
      output: "2 passed\n",
      exitCode: 0,
    });
    expect(byId("tool:call_bash2")).toMatchObject({ status: "failed" });
  });

  it("shows a running tool as in progress and an errored one as failed", () => {
    expect(byId("tool:call_slow")).toMatchObject({ status: "in_progress" });
    expect(byId("tool:call_bad")).toMatchObject({ status: "failed" });
  });

  it("turns todowrite into a plan and records usage and title", () => {
    expect(byId("tool:call_todo")).toBeUndefined();
    expect(items.find((item) => item.kind === "plan")).toMatchObject({
      entries: [
        { content: "补 README", status: "completed" },
        { content: "跑测试", status: "in_progress" },
      ],
    });
    expect(head.usage).toEqual({ used: 9150, size: 200000 });
    expect(head.title).toBe("补 README 并跑测试");
  });
});

describe("opencode incremental reads", () => {
  it("re-reading the same rows changes nothing", () => {
    const { lines } = readOpencode(memoryDb(), SID, undefined);
    const once = convertAll(opencodeTranscript, lines);
    const twice = convertAll(opencodeTranscript, [...lines, ...lines]);
    expect(twice.items).toEqual(once.items);
  });

  it("follows a tool from running to completed", () => {
    const database = memoryDb((id) => id !== "msg_04" && id !== "msg_05");
    const start = readOpencode(database, SID, undefined);
    expect(start.reset).toBe(true);

    // 助手还在跑 bash：part 先是 running。
    const running = {
      type: "tool",
      callID: "call_x",
      tool: "bash",
      state: {
        status: "running",
        input: { command: "sleep 1" },
        time: { start: 30_000 },
      },
    };
    const now = fixture.session.time_updated + 100;
    database
      .prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)")
      .run(
        "msg_09",
        SID,
        now,
        now,
        JSON.stringify({ role: "user", time: { created: now } }),
      );
    database.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
      "prt_09a",
      "msg_09",
      SID,
      now,
      now,
      JSON.stringify({
        type: "text",
        text: "再跑一次",
        time: { start: now, end: now },
      }),
    );
    database.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
      "msg_10",
      SID,
      now + 1,
      now + 1,
      JSON.stringify({
        role: "assistant",
        parentID: "msg_09",
        time: { created: now + 1 },
      }),
    );
    database
      .prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)")
      .run("prt_10a", "msg_10", SID, now + 2, now + 2, JSON.stringify(running));
    const second = readOpencode(database, SID, start.cursor);
    expect(second.reset).toBe(false);
    expect(second.lines.length).toBeGreaterThan(0);
    // 只给新的：不再带第一批里那些旧消息。
    expect(second.lines.join("\n")).not.toContain("prt_02c");

    const done = {
      ...running,
      state: {
        status: "completed",
        input: { command: "sleep 1" },
        output: "ok\n",
        metadata: { exit: 0 },
        time: { start: 30_000, end: 31_000 },
      },
    };
    database
      .prepare(
        "UPDATE part SET data = ?, time_updated = ? WHERE id = 'prt_10a'",
      )
      .run(JSON.stringify(done), now + 500);
    const third = readOpencode(database, SID, second.cursor);
    expect(third.lines).toHaveLength(1);

    const all = [...start.lines, ...second.lines, ...third.lines];
    const { items } = convertAll(opencodeTranscript, all);
    expect(items.find((item) => item.id === "tool:call_x")).toMatchObject({
      status: "completed",
    });
    // 中间状态也看得见：只读到前两批时还是进行中。
    const partial = convertAll(opencodeTranscript, [
      ...start.lines,
      ...second.lines,
    ]);
    expect(
      partial.items.find((item) => item.id === "tool:call_x"),
    ).toMatchObject({
      status: "in_progress",
    });
  });

  it("reads only the latest messages on first takeover and resets for another session", () => {
    const database = new DatabaseSync(":memory:");
    createSchema(database);
    database
      .prepare("INSERT INTO session VALUES ('s9', NULL, '/w', 't', 1, 1)")
      .run();
    for (let i = 0; i < FIRST_MESSAGES + 10; i++) {
      database
        .prepare("INSERT INTO message VALUES (?, 's9', ?, ?, ?)")
        .run(
          `m${String(i).padStart(3, "0")}`,
          i + 1,
          i + 1,
          JSON.stringify({ role: "user", time: { created: i + 1 } }),
        );
    }
    const first = readOpencode(database, "s9", undefined);
    const messages = first.lines.filter((line) => line.startsWith('{"k":"m"'));
    expect(messages).toHaveLength(FIRST_MESSAGES);
    expect(messages[0]).toContain('"m010"');
    // 游标属于另一个会话：重新来过。
    const again = readOpencode(database, "s9", { s: "other", t: 999 });
    expect(again.reset).toBe(true);
  });

  it("finds the session by directory when the hook gave no id", () => {
    const database = memoryDb();
    expect(
      sessionOf(database, {
        agentId: "opencode",
        cwd: "/work/demo",
        startedAtMs: 0,
      }),
    ).toBe(SID);
    expect(
      sessionOf(database, {
        agentId: "opencode",
        cwd: "/elsewhere",
        startedAtMs: 0,
      }),
    ).toBeUndefined();
    expect(sessionOf(database, { agentId: "opencode", sessionId: "x" })).toBe(
      "x",
    );
  });
});

describe("hook → opencode database → timeline", () => {
  const SESSION = "sess-oc";
  let dir: string;
  let timers: FakeTimers;
  let r: Rig;
  let saved: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "armadra-oc-"));
    saved = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dir;
    mkdirSync(join(dir, "opencode"));
    timers = new FakeTimers();
    r = rig({ timers, watch: () => ({ close() {} }) });
    insertSession(r.fixture, {
      id: SESSION,
      status: "running",
      agentId: "opencode",
    });
  });

  afterEach(() => {
    r.close();
    if (saved === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  const hook = (payload: Record<string, unknown>) => {
    const event = normalizeAs(
      "opencode",
      "opencode",
      r.fixture.nodeId,
      payload,
    );
    if (event === undefined) throw new Error("not understood");
    r.domain.sources.onHook(r.fixture.nodeId, event);
  };
  const itemIds = () =>
    Object.keys(r.domain.writer.state(SESSION)?.items ?? {});

  it("tails the database after a hook and resumes from the stored cursor", () => {
    const file = join(dir, "opencode", "opencode.db");
    const database = new DatabaseSync(file);
    createSchema(database);
    insert(database, fixture, (id) => id <= "msg_03");
    database.close();

    hook({
      event: "message.updated",
      properties: { info: { role: "user", sessionID: SID } },
    });
    expect(r.domain.activity.get(SESSION)?.phase).toBe("submitting");
    timers.advance(400);
    expect(itemIds()).toContain("tool:call_bash");
    expect(r.domain.store.get(SESSION)?.source).toBe("transcript");
    const stored = r.domain.store.get(SESSION)?.sourceCursor ?? "";
    expect(JSON.parse(stored)).toMatchObject({ v: 1, s: SID });

    // 新的 hook：工具开始，活动显示运行的命令。
    hook({
      event: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          tool: "bash",
          callID: "c1",
          sessionID: SID,
          state: { status: "running", input: { command: "pnpm build" } },
        },
      },
    });
    expect(r.domain.activity.get(SESSION)).toMatchObject({
      phase: "tool",
      detail: { label: "bash: pnpm build", toolKind: "execute" },
    });

    // 库里多了第二个回合：下一次读只补新的。
    const again = new DatabaseSync(file);
    insert(again, fixture, (id) => id > "msg_03");
    again.close();
    hook({ event: "session.idle", properties: { sessionID: SID } });
    timers.advance(400);
    expect(itemIds()).toContain("tool:call_bad");
    expect(r.domain.activity.get(SESSION)).toMatchObject({ phase: "idle" });
  });
});
