import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { refresh, listConversations } from "../conversations";
import { memoryDatabase } from "../timeline/testing";
import { BUILT_IN_PRICES, ScanState, summarize } from "../usage/cost";
import {
  candidates,
  forgetListingsForTest,
  grokAdapter,
  locate,
  parse,
  readEntries,
  roots,
  unreadable,
  updateEntries,
} from "./grok";
import { historyAdapter, locateHistory, readHistoryEntries } from "./registry";

/**
 * Grok Build 的本地历史适配器。夹具是合成的：形状照 1.0.92 的 `summary.json` 与
 * `updates.jsonl`，内容全是编的。
 */

const CWD = "/work/demo project";
const SID = "00000000-0000-7000-8000-00000000g101";

let home: string;
let previous: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "armadra-test-grok-home-"));
  previous = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  forgetListingsForTest();
});

afterEach(() => {
  if (previous === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});

function row(
  method: string,
  update: Record<string, unknown>,
  us: number,
  sessionId = SID,
): string {
  return JSON.stringify({
    timestamp: Math.floor(us / 1e6),
    timestamp_us: us,
    method,
    params: { sessionId, update },
  });
}

const BASE = Date.now() * 1000 - 3_600_000_000;

function turnLines(sessionId = SID, prompt = "p-0", ticks = 50_000_000) {
  return [
    row(
      "session/update",
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "  Fix the login page  " },
      },
      BASE + 1_000_000,
      sessionId,
    ),
    row(
      "session/update",
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Looking." },
      },
      BASE + 2_000_000,
      sessionId,
    ),
    row(
      "session/update",
      {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "read_file",
        rawInput: { path: "a.css" },
        _meta: { "x.ai/tool": { name: "read_file", kind: "read" } },
      },
      BASE + 3_000_000,
      sessionId,
    ),
    row(
      "_x.ai/session/update",
      {
        sessionUpdate: "turn_completed",
        prompt_id: prompt,
        stop_reason: "end_turn",
        usage: {
          modelUsage: {
            "grok-test": {
              inputTokens: 1000,
              outputTokens: 50,
              cachedReadTokens: 600,
              cacheCreationTokens: 0,
              costUsdTicks: ticks,
            },
          },
        },
      },
      BASE + 4_000_000,
      sessionId,
    ),
  ];
}

function writeSession(
  id: string,
  options: {
    group?: string;
    summary?: Record<string, unknown> | string | null;
    lines?: string[];
  } = {},
): string {
  const dir = join(
    home,
    "sessions",
    options.group ?? encodeURIComponent(CWD),
    id,
  );
  mkdirSync(dir, { recursive: true });
  const summary = options.summary;
  if (summary !== null) {
    writeFileSync(
      join(dir, "summary.json"),
      typeof summary === "string"
        ? summary
        : JSON.stringify(
            summary ?? {
              info: { id, cwd: CWD },
              generated_title: "Fix the login page",
              session_summary: "older summary",
              updated_at: "2026-11-25T05:31:33Z",
            },
          ),
    );
  }
  const path = join(dir, "updates.jsonl");
  writeFileSync(path, (options.lines ?? turnLines(id)).join("\n") + "\n");
  return path;
}

describe("Grok 会话索引", () => {
  it("roots 是 $GROK_HOME/sessions，没有家目录也没有覆盖时没有根", () => {
    expect(roots({ GROK_HOME: "/x/y" })).toEqual([join("/x/y", "sessions")]);
    expect(roots({ HOME: "/h" })).toEqual([join("/h", ".grok", "sessions")]);
    expect(roots({ HOME: "" })).toEqual([]);
  });

  it("列出每个会话目录里的 updates.jsonl，标题取 generated_title，cwd 取 summary.json", () => {
    const path = writeSession(SID);
    writeSession("sess-empty-dir", { lines: [] });
    const found = candidates(roots()[0] as string);
    expect(found.map((one) => one.path).sort()).toContain(path);
    const parsed = parse(path);
    expect(parsed).toEqual({
      sessionId: SID,
      title: "Fix the login page",
      cwd: CWD,
    });
  });

  it("标题顺序：generated_title、session_summary、首条用户消息、空串", () => {
    const a = writeSession("a", {
      summary: { info: { id: "a", cwd: CWD }, session_summary: "from summary" },
    });
    expect(parse(a)?.title).toBe("from summary");
    const b = writeSession("b", { summary: { info: { id: "b", cwd: CWD } } });
    expect(parse(b)?.title).toBe("Fix the login page");
    const c = writeSession("c", {
      summary: { info: { id: "c", cwd: CWD } },
      lines: [],
    });
    expect(parse(c)).toEqual({ sessionId: "c", title: "", cwd: CWD });
  });

  it("summary.json 坏了或不是认得的形状：降级成目录名与首条用户消息，不抛错", () => {
    for (const summary of ["{broken", "[]", '{"info": 5}', null]) {
      const path = writeSession("d", { summary });
      expect(parse(path)).toEqual({
        sessionId: "d",
        title: "Fix the login page",
        cwd: "",
      });
    }
  });

  it("目录名取分组的真实名字，不依赖平台的路径分隔符", () => {
    // Windows 的 cwd 编码成 C%3A%5CUsers%5C…，目录名里没有分隔符。
    const group = encodeURIComponent("C:\\Users\\me\\proj");
    const path = writeSession("win", {
      group,
      summary: { info: { id: "win", cwd: "C:\\Users\\me\\proj" } },
    });
    expect(parse(path)?.cwd).toBe("C:\\Users\\me\\proj");
    expect(
      locate({ agentId: "grok", sessionId: "win", cwd: "C:\\Users\\me\\proj" })
        ?.path,
    ).toBe(path);
  });

  it("根下读不了：回上一趟读成功的，不清空；从没成功过时标记 unreadable", () => {
    const path = writeSession(SID);
    const root = roots()[0] as string;
    expect(candidates(root).map((one) => one.path)).toEqual([path]);
    chmodSync(root, 0o000);
    try {
      if (process.platform !== "win32" && process.getuid?.() !== 0) {
        expect(candidates(root).map((one) => one.path)).toEqual([path]);
        expect(unreadable(root)).toBe(false);
        forgetListingsForTest();
        expect(candidates(root)).toEqual([]);
        expect(unreadable(root)).toBe(true);
      }
    } finally {
      chmodSync(root, 0o755);
    }
    // 根没了是「这台机器上没有」，不是读失败。
    rmSync(root, { recursive: true });
    expect(candidates(root)).toEqual([]);
    expect(unreadable(root)).toBe(false);
  });

  it("会话索引：读不了的根不对账（已有的行留着），根没了才清", () => {
    const database = memoryDatabase();
    writeSession(SID);
    const root = roots()[0] as string;
    refresh(database, [["grok", root]]);
    expect(
      listConversations(database, "", 50).map((c) => c.sessionId),
    ).toContain(SID);
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      forgetListingsForTest();
      chmodSync(root, 0o000);
      try {
        refresh(database, [["grok", root]]);
      } finally {
        chmodSync(root, 0o755);
      }
      expect(
        listConversations(database, "", 50).map((c) => c.sessionId),
      ).toContain(SID);
    }
    rmSync(root, { recursive: true });
    refresh(database, [["grok", root]]);
    expect(listConversations(database, "", 50)).toEqual([]);
  });
});

describe("Grok 定位与读取", () => {
  it("按会话 id 与 cwd 找；cwd 对不上时在根下一层按 id 找；不安全的 id 不拼路径", () => {
    const path = writeSession(SID);
    const hint = { agentId: "grok", sessionId: SID, cwd: CWD };
    expect(locate(hint)?.path).toBe(path);
    expect(locate({ ...hint, cwd: "/elsewhere" })?.path).toBe(path);
    expect(locate({ agentId: "grok" })).toBeUndefined();
    for (const bad of ["..", "../x", "a/b", "a\\b", ""]) {
      expect(locate({ ...hint, sessionId: bad })).toBeUndefined();
    }
    expect(locateHistory(hint)?.path).toBe(path);
  });

  it("上报的转录路径先认", () => {
    const path = writeSession(SID);
    expect(locateHistory({ agentId: "grok", transcriptPath: path })?.path).toBe(
      path,
    );
  });

  it("读成归一化记录：用户、助手、工具调用；其余略过；偏移是字节", () => {
    const path = writeSession(SID);
    const located = locate({ agentId: "grok", sessionId: SID, cwd: CWD })!;
    const range = readEntries(located, 0, 1 << 20);
    expect(range.entries.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "assistant",
    ]);
    expect(range.entries[0]?.blocks[0]).toEqual({
      type: "text",
      text: "  Fix the login page  ",
    });
    expect(range.entries[2]?.blocks[0]).toMatchObject({
      type: "tool_use",
      name: "read_file",
      id: "call-1",
    });
    // 增量：从第一条之后读。
    const first = range.entries[0]!.endOffset;
    const since = readHistoryEntries("grok", located, first, 1 << 20);
    expect(since.entries.map((entry) => entry.role)).toEqual([
      "assistant",
      "assistant",
    ]);
    expect(path).toBe(located.path);
  });

  it("半行不读；坏行与不认得的形状略过", () => {
    const entries = updateEntries(
      [
        "garbage",
        "{}",
        '{"params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"ok"}}}}',
      ].join("\n") + '\n{"params":',
    );
    expect(entries).toHaveLength(1);
  });

  it("注册表里认得 grok，并且读得出内容（不是只有索引）", () => {
    expect(historyAdapter("grok")).toBe(grokAdapter);
    expect(grokAdapter.readsEntries).toBeUndefined();
  });
});

describe("Grok 成本", () => {
  it("每回合按模型记 token（input 去掉缓存读）与 grok 自己报的美元（10^10 tick = 1 美元）", async () => {
    writeSession(SID, {
      lines: [
        ...turnLines(SID, "p-0", 50_000_000),
        ...turnLines(SID, "p-1", 150_000_000),
      ],
    });
    // 同一个回合重复（分叉出来的会话逐字重复前面的行）只计一次。
    writeSession("fork", {
      lines: turnLines(SID, "p-0", 50_000_000),
    });
    const scan = await new ScanState().scan([["grok", roots()[0] as string]]);
    const summary = summarize(scan, BUILT_IN_PRICES, Date.now());
    const grok = summary.ranges["24h"].byAgent.find(
      (one) => one.agent === "grok",
    );
    expect(grok?.tokens).toEqual({
      input: (1000 - 600) * 2,
      output: 100,
      cacheRead: 1200,
      cacheCreation: 0,
    });
    // 模型不在价格表里：用 grok 报的美元兜底（0.005 + 0.015）。
    expect(grok?.costUsd).toBeCloseTo(0.02, 6);
  });

  it("不是 updates.jsonl 的 jsonl（events、chat_history）不计", async () => {
    const path = writeSession(SID);
    writeFileSync(
      path.replace("updates.jsonl", "events.jsonl"),
      turnLines().join("\n") + "\n",
    );
    const scan = await new ScanState().scan([["grok", roots()[0] as string]]);
    const summary = summarize(scan, BUILT_IN_PRICES, Date.now());
    const grok = summary.ranges["24h"].byAgent.find(
      (one) => one.agent === "grok",
    );
    expect(grok?.tokens.output).toBe(50);
  });

  it("不认得的回合用量形状：不计、不抛", () => {
    const state = {
      agent: "grok" as const,
      len: 0,
      mtimeMs: 0,
      offset: 0,
      modifiedMs: 0,
      model: undefined,
      buckets: new Map(),
      hourBuckets: new Map(),
    };
    const source =
      grokAdapter.cost?.kind === "jsonl" ? grokAdapter.cost.source : undefined;
    const context = { nowMs: Date.now(), seen: new Set<number>() };
    for (const value of [
      null,
      {},
      { params: { update: { sessionUpdate: "turn_completed" } } },
      {
        params: {
          update: { sessionUpdate: "turn_completed", usage: { modelUsage: 5 } },
        },
      },
    ]) {
      source?.absorb(state, value, context);
    }
    expect(state.buckets.size).toBe(0);
  });
});
