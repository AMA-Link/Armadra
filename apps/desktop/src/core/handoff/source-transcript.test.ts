import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { createControlDispatcher } from "../collab/control";
import { setAcpTimelineSource } from "../history/registry";
import { locateHistory } from "../history/registry";
import { tempDir } from "../testing/temp-dir";
import { EMPTY_SECTIONS, type HandoffBundle } from "./bundle";
import {
  type FrozenCursor,
  type RangeAnswer,
  type RangeRequest,
  PAGE_BYTES,
  freezeCursor,
  readSourceRange,
} from "./source-range";
import { readSourceTranscript } from "./source-transcript";
import { accept, prepare, readForCaller } from "./store";

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

const CLAUDE = [
  line({ type: "user", message: { role: "user", content: "first ask" } }),
  line({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "looking" },
        {
          type: "tool_use",
          id: "t1",
          name: "Read",
          input: { file_path: "a.ts" },
        },
      ],
    },
  }),
  line({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "x".repeat(900) },
      ],
    },
  }),
  line({ type: "assistant", message: { role: "assistant", content: "done" } }),
];

const CODEX = [
  line({
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "first ask" }],
    },
  }),
  line({
    type: "response_item",
    payload: {
      type: "function_call",
      name: "shell",
      arguments: '{"command":"ls"}',
      call_id: "c1",
    },
  }),
  line({
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "done" }],
    },
  }),
];

const PI = [
  line({ type: "message", message: { role: "user", content: "first ask" } }),
  line({
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "looking" },
        {
          type: "toolCall",
          id: "p1",
          name: "read",
          arguments: { path: "a.ts" },
        },
      ],
    },
  }),
  line({
    type: "message",
    message: { role: "toolResult", toolCallId: "p1", content: "body" },
  }),
  line({ type: "message", message: { role: "assistant", content: "done" } }),
];

const ev = (type: string, data: Record<string, unknown>, at: string) =>
  line({ type, data, id: `e-${type}-${at}`, timestamp: at, parentId: null });

const COPILOT = [
  ev("session.start", { sessionId: "s1" }, "2026-11-08T09:00:00.000Z"),
  ev("user.message", { content: "first ask" }, "2026-11-08T09:00:01.000Z"),
  ev(
    "assistant.message",
    {
      content: "looking",
      toolRequests: [
        { toolCallId: "k1", name: "view", arguments: { path: "a.ts" } },
      ],
    },
    "2026-11-08T09:00:02.000Z",
  ),
  ev("assistant.message", { content: "done" }, "2026-11-08T09:00:03.000Z"),
];

function request(
  agentId: string,
  cursor: FrozenCursor,
  extra: Partial<RangeRequest> = {},
): RangeRequest {
  return {
    agentId,
    locatedKey: cursor.locatedKey,
    unit: cursor.unit,
    endOffset: cursor.endOffset,
    prefixSha256: cursor.prefixSha256,
    ...(cursor.lastEntrySha256 === undefined
      ? {}
      : { lastEntrySha256: cursor.lastEntrySha256 }),
    fromOffset: 0,
    maxBytes: PAGE_BYTES,
    raw: false,
    ...extra,
  };
}

/** 一页一页读到 done，返回所有页。 */
function pages(base: RangeRequest): Extract<RangeAnswer, { state: "ok" }>[] {
  const out: Extract<RangeAnswer, { state: "ok" }>[] = [];
  let from = 0;
  for (let guard = 0; guard < 200; guard += 1) {
    const answer = readSourceRange({ ...base, fromOffset: from });
    if (answer.state !== "ok") throw new Error(answer.state);
    out.push(answer);
    if (answer.done) return out;
    from = answer.nextOffset;
  }
  throw new Error("did not finish");
}

const SHAPE = {
  role: expect.stringMatching(/^(user|assistant|system)$/),
  text: expect.any(String),
  tools: expect.any(Array),
  results: expect.any(Array),
};

describe("freezing and reading a file source", () => {
  let directory: string;
  beforeEach(() => {
    directory = tempDir("armadra-source-range-");
  });

  const write = (name: string, lines: string[]) => {
    const path = join(directory, name);
    writeFileSync(path, lines.join(""));
    return path;
  };
  const freeze = (agentId: string, path: string) => {
    const located = locateHistory({ agentId, transcriptPath: path });
    const cursor = freezeCursor(agentId, located!);
    expect(cursor).toBeDefined();
    return cursor as FrozenCursor;
  };

  it.each([
    ["claude", CLAUDE],
    ["codex", CODEX],
    ["pi", PI],
    ["copilot", COPILOT],
  ])("%s: every entry has the one shape, from the start", (agentId, lines) => {
    const path = write(`${agentId}.jsonl`, lines);
    const cursor = freeze(agentId, path);
    expect(cursor.unit).toBe("bytes");
    expect(cursor.endOffset).toBe(Buffer.byteLength(lines.join("")));
    expect(cursor.prefixSha256).toHaveLength(64);
    const [only] = pages(request(agentId, cursor));
    expect(only?.done).toBe(true);
    expect(only?.entries?.length).toBeGreaterThanOrEqual(2);
    for (const entry of only?.entries ?? []) expect(entry).toMatchObject(SHAPE);
    expect(only?.entries?.[0]).toMatchObject({
      role: "user",
      text: "first ask",
    });
    if (agentId !== "codex" && agentId !== "copilot") {
      expect(only?.entries?.some((entry) => entry.tools.length > 0)).toBe(true);
    }
  });

  it("copilot: tool requests come through in the one shape", () => {
    const path = write("events.jsonl", COPILOT);
    const cursor = freeze("copilot", path);
    const entries = pages(request("copilot", cursor)).flatMap(
      (page) => page.entries ?? [],
    );
    expect(entries.map((entry) => entry.text)).toEqual(
      expect.arrayContaining(["first ask", "done"]),
    );
  });

  it("counts a line too long to read instead of dropping it silently", () => {
    const huge = line({
      type: "assistant",
      message: { role: "assistant", content: "y".repeat(4.5 * 1024 * 1024) },
    });
    const path = write("long.jsonl", [
      CLAUDE[0] as string,
      huge,
      CLAUDE[3] as string,
    ]);
    const cursor = freeze("claude", path);
    const all = pages(request("claude", cursor));
    expect(all.reduce((sum, page) => sum + (page.skippedLines ?? 0), 0)).toBe(
      1,
    );
    const texts = all.flatMap((page) =>
      (page.entries ?? []).map((e) => e.text),
    );
    expect(texts).toEqual(["first ask", "done"]);
  });

  it("stops at the frozen boundary: later appends never show", () => {
    const path = write("c.jsonl", CLAUDE);
    const cursor = freeze("claude", path);
    appendFileSync(
      path,
      line({
        type: "assistant",
        message: { role: "assistant", content: "AFTER FREEZE" },
      }),
    );
    const texts = pages(request("claude", cursor)).flatMap((page) =>
      (page.entries ?? []).map((entry) => entry.text),
    );
    expect(texts).toContain("done");
    expect(texts.join("|")).not.toContain("AFTER FREEZE");
  });

  it("an append that is only a half line does not move the boundary", () => {
    const path = write("h.jsonl", CLAUDE);
    appendFileSync(path, '{"type":"user","message":{"role":"us');
    const cursor = freeze("claude", path);
    expect(cursor.endOffset).toBe(Buffer.byteLength(CLAUDE.join("")));
  });

  it("pages are contiguous: no repeats, no gaps, whatever the page size", () => {
    const many = Array.from({ length: 300 }, (_, index) =>
      line({
        type: index % 2 === 0 ? "user" : "assistant",
        message: {
          role: index % 2 === 0 ? "user" : "assistant",
          content: `message ${index} ${"y".repeat(400)}`,
        },
      }),
    );
    const path = write("many.jsonl", many);
    const cursor = freeze("claude", path);
    for (const maxItems of [undefined, 7]) {
      const all = pages(
        request("claude", cursor, maxItems === undefined ? {} : { maxItems }),
      );
      if (maxItems === undefined) expect(all.length).toBeGreaterThan(1);
      const numbers = all.flatMap((page) =>
        (page.entries ?? []).map((entry) =>
          Number(/message (\d+)/.exec(entry.text)?.[1]),
        ),
      );
      expect(numbers).toEqual(Array.from({ length: 300 }, (_, index) => index));
      for (const page of all) {
        expect(
          Buffer.byteLength(JSON.stringify(page.entries)),
        ).toBeLessThanOrEqual(PAGE_BYTES);
      }
    }
  });

  it("raw gives the original lines of the same range, secrets redacted", () => {
    const secret = line({
      type: "user",
      message: { role: "user", content: "key sk-abcdefghijklmnopqrstuvwxyz" },
    });
    const path = write("r.jsonl", [...CLAUDE, secret]);
    const cursor = freeze("claude", path);
    const raws = pages(request("claude", cursor, { raw: true })).flatMap(
      (page) => page.rawLines ?? [],
    );
    expect(raws.slice(0, 4)).toEqual(CLAUDE.map((each) => each.trimEnd()));
    expect(raws[4]).toContain("[REDACTED]");
    expect(raws[4]).not.toContain("sk-abcdefghij");
    for (const each of raws) expect(() => JSON.parse(each)).not.toThrow();
  });

  it("a rewritten prefix reads as changed; a vanished file as missing", () => {
    const path = write("x.jsonl", CLAUDE);
    const cursor = freeze("claude", path);
    writeFileSync(
      path,
      CLAUDE.map((each) => each.replace("first", "FIRST")).join("") + line({}),
    );
    expect(readSourceRange(request("claude", cursor)).state).toBe("changed");
    const gone = freeze("claude", write("y.jsonl", CLAUDE));
    expect(
      readSourceRange(
        request("claude", {
          ...gone,
          locatedKey: join(directory, "none.jsonl"),
        }),
      ).state,
    ).toBe("missing");
  });

  it("refuses a cursor that is not at a line start", () => {
    const path = write("z.jsonl", CLAUDE);
    const cursor = freeze("claude", path);
    expect(
      readSourceRange(request("claude", cursor, { fromOffset: 5 })).state,
    ).toBe("badCursor");
    expect(
      readSourceRange(
        request("claude", cursor, { fromOffset: cursor.endOffset + 1 }),
      ).state,
    ).toBe("badCursor");
  });
});

describe("sources without a byte cursor", () => {
  afterEach(() => setAcpTimelineSource(undefined));

  it("an ACP timeline is read by entry count and stops at the boundary", () => {
    const directory = tempDir("armadra-acp-range-");
    const path = join(directory, "s.acp.jsonl");
    const items: unknown[] = [
      { kind: "user", text: "ask", at: 1000 },
      {
        kind: "assistant",
        parts: [{ type: "text", text: "answer" }],
        at: 2000,
      },
    ];
    setAcpTimelineSource(() => items as never);
    const located = locateHistory({ agentId: "claude", transcriptPath: path });
    const cursor = freezeCursor("claude", located!) as FrozenCursor;
    expect(cursor).toMatchObject({ unit: "entries", endOffset: 2 });
    expect(cursor.prefixSha256).toHaveLength(64);
    expect(cursor.lastEntrySha256).toHaveLength(64);
    items.push({ kind: "user", text: "LATER", at: 3000 });
    const [page] = pages(request("claude", cursor));
    expect(page?.entries?.map((entry) => entry.text)).toEqual([
      "ask",
      "answer",
    ]);
    expect(page?.cursorText).toBe("2 条");
    const [raw] = pages(request("claude", cursor, { raw: true }));
    expect(JSON.parse(raw?.rawLines?.[0] as string)).toMatchObject({
      role: "user",
    });
    const second = readSourceRange(
      request("claude", cursor, { fromOffset: 1, maxItems: 1 }),
    );
    expect(second).toMatchObject({ state: "ok", done: true });
  });

  it("an ACP entry still growing after the freeze is withheld, not leaked", () => {
    const directory = tempDir("armadra-acp-grow-");
    const path = join(directory, "s.acp.jsonl");
    const answer = {
      kind: "assistant",
      parts: [{ type: "text", text: "part" }],
      at: 2000,
    };
    const items: unknown[] = [{ kind: "user", text: "ask", at: 1000 }, answer];
    setAcpTimelineSource(() => items as never);
    const located = locateHistory({ agentId: "claude", transcriptPath: path });
    const cursor = freezeCursor("claude", located!) as FrozenCursor;
    answer.parts = [{ type: "text", text: "part AND MORE AFTER FREEZE" }];
    const [page] = pages(request("claude", cursor));
    expect(page?.entries?.map((entry) => entry.text)).toEqual(["ask"]);
    expect(page?.lastEntryChanged).toBe(true);
    items[0] = { kind: "user", text: "rewritten", at: 1000 };
    expect(readSourceRange(request("claude", cursor))).toEqual({
      state: "changed",
    });
  });

  describe("OpenCode", () => {
    let previous: string | undefined;
    let xdg: string;
    beforeEach(() => {
      previous = process.env.XDG_DATA_HOME;
      xdg = tempDir("armadra-oc-range-");
      process.env.XDG_DATA_HOME = xdg;
      mkdirSync(join(xdg, "opencode"), { recursive: true });
      const database = new DatabaseSync(join(xdg, "opencode", "opencode.db"));
      database.exec(
        "CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, title TEXT NOT NULL, time_updated INTEGER NOT NULL, cost REAL NOT NULL DEFAULT 0, tokens_input INTEGER NOT NULL DEFAULT 0);" +
          "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);" +
          "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
      );
      database.close();
    });
    afterEach(() => {
      if (previous === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previous;
    });
    const add = (id: string, at: number, role: string, text: string) => {
      const database = new DatabaseSync(join(xdg, "opencode", "opencode.db"));
      database
        .prepare("INSERT INTO message VALUES (?, 'ses', ?, ?, ?)")
        .run(id, at, at, JSON.stringify({ role }));
      database
        .prepare("INSERT INTO part VALUES (?, ?, 'ses', 0, 0, ?)")
        .run(`p_${id}`, id, JSON.stringify({ type: "text", text }));
      database.close();
    };

    it("reads to the frozen cursor, one shape, raw as entry JSON", () => {
      add("m1", 1000, "user", "first ask");
      add("m2", 2000, "assistant", "done");
      const located = locateHistory({ agentId: "opencode", sessionId: "ses" });
      const cursor = freezeCursor("opencode", located!) as FrozenCursor;
      expect(cursor.unit).toBe("opaque");
      add("m3", 3000, "user", "AFTER FREEZE");
      const all = pages(request("opencode", cursor));
      const entries = all.flatMap((page) => page.entries ?? []);
      expect(entries.map((entry) => entry.text)).toEqual(["first ask", "done"]);
      for (const entry of entries) expect(entry).toMatchObject(SHAPE);
      const raw = pages(request("opencode", cursor, { raw: true })).flatMap(
        (page) => page.rawLines ?? [],
      );
      expect(raw).toHaveLength(2);
      expect(JSON.parse(raw[0] as string)).toMatchObject({ role: "user" });
      // paging one at a time is gapless
      const first = readSourceRange(
        request("opencode", cursor, { maxItems: 1 }),
      );
      expect(first).toMatchObject({ state: "ok", done: false });
      const next = readSourceRange(
        request("opencode", cursor, {
          maxItems: 1,
          fromOffset: (first as { nextOffset: number }).nextOffset,
        }),
      );
      expect(
        (next as unknown as { entries: { text: string }[] }).entries.map(
          (entry) => entry.text,
        ),
      ).toEqual(["done"]);
    });
  });
});

describe("handoff-read --part transcript", () => {
  let fixture: AgentFixture;
  let source: string;
  let target: string;
  let sourceSession: string;
  let targetSession: string;
  let transcript: string;

  beforeEach(() => {
    fixture = agentFixture();
    source = fixture.agentNode("Source");
    target = fixture.agentNode("Target", "codex");
    fixture.link(source, target);
    sourceSession = fixture.session(source, "claude");
    targetSession = fixture.session(target, "codex");
    transcript = join(tempDir("armadra-handoff-src-"), "s.jsonl");
    writeFileSync(transcript, CLAUDE.join(""));
    fixture.database
      .prepare(
        "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, unread, verified, restored, updated_at, session_id, transcript_path) VALUES (?, ?, 'claude', 'done', 0, 1, 0, ?, 's', ?)",
      )
      .run(source, fixture.workspaceId, new Date().toISOString(), transcript);
  });
  afterEach(() => fixture.close());

  const prepared = async () =>
    await prepare(fixture.collab, fixture.workspaceId, {
      sourceNodeId: source,
      sourceSessionId: sourceSession,
      sourceGeneration: 1,
      target: {
        kind: "node",
        nodeId: target,
        sessionId: targetSession,
        generation: 1,
      },
      sections: { ...EMPTY_SECTIONS, goal: "go" },
      filePaths: [],
      byteBudget: 8192,
      includeTranscript: true,
    } as never);
  const read = async (id: string, options: Record<string, unknown>) =>
    await readForCaller(
      fixture.collab,
      callerFor(fixture, target),
      id,
      targetSession,
      1,
      options as never,
    );

  it("freezes a v2 bundle with the cursor, and reads it page by page", async () => {
    const view = await prepared();
    expect(view.bundle.version).toBe(2);
    expect(view.bundle.sourceCursor).toMatchObject({
      agentId: "claude",
      executionHost: "local-runtime",
      unit: "bytes",
      endOffset: Buffer.byteLength(CLAUDE.join("")),
    });
    accept(fixture.collab, fixture.workspaceId, view.bundle.handoffId, {
      expectedDigest: view.digest,
    });
    appendFileSync(
      transcript,
      line({ type: "user", message: { role: "user", content: "AFTER" } }),
    );
    const first = await read(view.bundle.handoffId, {
      part: "transcript",
      limit: 2,
    });
    expect(first).toMatchObject({
      part: "transcript",
      mode: "entries",
      done: false,
      source: { agentId: "claude", provider: "claude", nodeTitle: "Source" },
    });
    const second = await read(view.bundle.handoffId, {
      part: "transcript",
      cursor: first.nextCursor as number,
    });
    expect(second).toMatchObject({ done: true, nextCursor: null });
    const text = JSON.stringify([first.entries, second.entries]);
    expect(text).toContain("first ask");
    expect(text).toContain("done");
    expect(text).not.toContain("AFTER");
    const rawPage = await read(view.bundle.handoffId, {
      part: "transcript",
      raw: true,
    });
    expect(rawPage.rawLines).toEqual(CLAUDE.map((each) => each.trimEnd()));
  });

  it("falls back to the frozen excerpt when the prefix no longer matches", async () => {
    const view = await prepared();
    accept(fixture.collab, fixture.workspaceId, view.bundle.handoffId, {
      expectedDigest: view.digest,
    });
    writeFileSync(
      transcript,
      `${CLAUDE.join("").replace("first", "FIRST")}${line({})}`,
    );
    const body = await read(view.bundle.handoffId, { part: "transcript" });
    expect(body).toMatchObject({
      mode: "excerpt",
      transcriptChanged: true,
      done: true,
    });
    expect(body.transcriptExcerpt).toBe(view.bundle.transcriptExcerpt);
    expect(body.transcriptExcerpt).toContain("first ask");
  });

  it("checks authorization before touching the source", async () => {
    const view = await prepared();
    // not accepted yet
    await expect(
      read(view.bundle.handoffId, { part: "transcript" }),
    ).rejects.toThrow(/not addressed/i);
    accept(fixture.collab, fixture.workspaceId, view.bundle.handoffId, {
      expectedDigest: view.digest,
    });
    await expect(
      readForCaller(
        fixture.collab,
        callerFor(fixture, source),
        view.bundle.handoffId,
        sourceSession,
        1,
        { part: "transcript" },
      ),
    ).rejects.toThrow();
    await expect(
      readForCaller(
        fixture.collab,
        callerFor(fixture, target),
        view.bundle.handoffId,
        targetSession,
        2,
        { part: "transcript" },
      ),
    ).rejects.toThrow();
    fixture.database.prepare("DELETE FROM context_links").run();
    await expect(
      read(view.bundle.handoffId, { part: "transcript" }),
    ).rejects.toThrow(/link/i);
  });

  it("the control verb passes part, cursor, limit and raw through, and validates them", async () => {
    const view = await prepared();
    accept(fixture.collab, fixture.workspaceId, view.bundle.handoffId, {
      expectedDigest: view.digest,
    });
    const dispatcher = createControlDispatcher(fixture.collab);
    const base = {
      id: view.bundle.handoffId,
      sessionId: targetSession,
      generation: 1,
    };
    const caller = callerFor(fixture, target);
    const ok = await dispatcher.dispatch("handoff-read", caller, {
      ...base,
      part: "transcript",
      limit: "1",
      raw: true,
    });
    if (!ok.ok) throw new Error(ok.message);
    expect(ok.body).toMatchObject({
      part: "transcript",
      mode: "raw",
      done: false,
    });
    expect((ok.body as { rawLines: string[] }).rawLines).toHaveLength(1);
    const plain = await dispatcher.dispatch("handoff-read", caller, {
      ...base,
      format: "json",
    });
    if (!plain.ok) throw new Error(plain.message);
    expect(plain.body).toHaveProperty("bundle");
    for (const bad of [
      { part: "nope" },
      { part: "transcript", cursor: "-3" },
      { limit: "0" },
    ]) {
      const refused = await dispatcher.dispatch("handoff-read", caller, {
        ...base,
        ...bad,
      });
      expect(refused).toMatchObject({ ok: false, status: 400 });
    }
    const wrong = await dispatcher.dispatch("handoff-read", caller, {
      ...base,
      part: "transcript",
      cursor: "7",
    });
    expect(wrong).toMatchObject({ ok: false, status: 400 });
  });

  it("a v1 bundle only has its excerpt", async () => {
    const view = await prepared();
    const v1 = {
      ...view.bundle,
      version: 1,
      sourceCursor: undefined,
    } as HandoffBundle;
    const body = await readSourceTranscript(v1);
    expect(body).toMatchObject({ mode: "excerpt", done: true });
    expect(String(body.reason)).toMatch(/v1/);
    expect(body.transcriptExcerpt).toBe(view.bundle.transcriptExcerpt);
  });
});
