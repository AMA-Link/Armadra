import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { convertAll, fixtureLines } from "./harness";
import { ompTranscript, piToolKind, piTranscript } from "./pi";

/** 脱敏的 Pi / OMP 会话夹具 → 时间线；完整序列固定在 `fixtures/pi/*.expected.json`。 */

describe("pi session → timeline", () => {
  const { items, head } = convertAll(
    piTranscript,
    fixtureLines("pi/session.jsonl"),
  );
  const byId = (id: string) => items.find((item) => item.id === id);

  it("matches the recorded conversion", async () => {
    await expect(
      JSON.stringify({ head, items }, null, 2) + "\n",
    ).toMatchFileSnapshot("./fixtures/pi/session.expected.json");
  });

  it("opens a turn per user message and ends it from the stop reason", () => {
    const users = items.filter((item) => item.kind === "user");
    expect(users.map((u) => (u.kind === "user" ? u.text : ""))).toEqual([
      "给 README 加一行并跑测试",
      "继续修复",
      "再试一次",
    ]);
    const turns = items.filter((item) => item.kind === "turn");
    expect(turns.map((t) => (t.kind === "turn" ? t.stopReason : ""))).toEqual([
      "end_turn",
      "cancelled",
      undefined,
    ]);
    expect(turns[2]).toMatchObject({
      error: { code: "error", message: "429 rate limited" },
    });
  });

  it("keeps a hidden thought as an empty item and the visible one", () => {
    const thoughts = items.filter((item) => item.kind === "thought");
    expect(thoughts.map((t) => (t.kind === "thought" ? t.text : ""))).toEqual([
      "",
      "想一下",
    ]);
  });

  it("builds diffs from the call arguments and falls back to details.diff", () => {
    const edit = byId("tool:call_edit|fc_2");
    expect(edit).toMatchObject({ toolKind: "edit", status: "completed" });
    expect(edit?.kind === "tool" && edit.content).toMatchObject([
      {
        type: "diff",
        path: "/work/demo/README.md",
        oldText: "# Demo",
        newText: "# Demo\n新增一行",
      },
    ]);
    const fallback = byId("tool:call_edit2|fc_3");
    expect(fallback?.kind === "tool" && fallback.content).toMatchObject([
      {
        type: "diff",
        path: "/work/demo/notes.txt",
        oldText: "keep\nold line",
        newText: "keep\nnew line",
      },
    ]);
    const write = byId("tool:call_write|fc_4");
    expect(write?.kind === "tool" && write.content).toMatchObject([
      { type: "diff", oldText: null, newText: "hello" },
    ]);
  });

  it("reads bash output, the exit code in the trailer, and a failed tool", () => {
    const ok = byId("tool:call_bash|fc_5");
    expect(ok).toMatchObject({ toolKind: "execute", status: "completed" });
    expect(ok?.kind === "tool" && ok.content[0]).toMatchObject({
      type: "terminal",
      command: "pnpm test",
      output: "2 passed\n",
    });
    const bad = byId("tool:call_bash2|fc_6");
    expect(bad).toMatchObject({ status: "failed" });
    expect(bad?.kind === "tool" && bad.content[0]).toMatchObject({
      output: "1 problem",
      exitCode: 1,
    });
  });

  it("cancels a tool the abort cut short", () => {
    expect(byId("tool:call_slow|fc_7")).toMatchObject({
      status: "cancelled",
    });
  });

  it("records usage (cache included), the title and a compaction notice", () => {
    expect(head.usage).toEqual({ used: 8550, size: 200000 });
    expect(head.title).toBe("补 README");
    expect(items.find((item) => item.kind === "notice")).toMatchObject({
      code: "compacted",
    });
  });

  it("classifies tool names", () => {
    expect(piToolKind("bash")).toBe("execute");
    expect(piToolKind("grep")).toBe("search");
    expect(piToolKind("subagent")).toBe("subagent");
    expect(piToolKind("codemode")).toBe("other");
  });
});

describe("omp session → timeline", () => {
  const { items, head } = convertAll(
    ompTranscript,
    fixtureLines("pi/omp.jsonl"),
  );
  const byId = (id: string) => items.find((item) => item.id === id);

  it("matches the recorded conversion", async () => {
    await expect(
      JSON.stringify({ head, items }, null, 2) + "\n",
    ).toMatchFileSnapshot("./fixtures/pi/omp.expected.json");
  });

  it("takes titles from the title records and the exit code from details", () => {
    expect(head.title).toBe("列出文件");
    expect(
      byId("tool:call_b")?.kind === "tool" && byId("tool:call_b"),
    ).toMatchObject({ status: "completed" });
    expect(byId("tool:call_b2")).toMatchObject({ status: "failed" });
    const content = byId("tool:call_b2");
    expect(content?.kind === "tool" && content.content[0]).toMatchObject({
      exitCode: 1,
    });
    expect(byId("tool:call_g")).toMatchObject({ toolKind: "search" });
  });

  it("ignores custom records", () => {
    expect(JSON.stringify(items)).not.toContain("customType");
  });
});

describe("locating a transcript when Pi and OMP share a directory", () => {
  let dir: string;
  const keys = [
    "PI_CODING_AGENT_DIR",
    "OMP_PROFILE",
    "PI_PROFILE",
    "PI_CONFIG_DIR",
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "armadra-pi-"));
    for (const key of keys) saved[key] = process.env[key];
    for (const key of keys) delete process.env[key];
    process.env.PI_CODING_AGENT_DIR = dir;
    const sessions = join(dir, "sessions", "--work-demo--");
    mkdirSync(sessions, { recursive: true });
    const fixtures = join(__dirname, "fixtures", "pi");
    const stamp = new Date(Date.now() + 60_000);
    // Pi 写的在前，OMP 写的更新：按「同目录里最新的」兜底会选到 OMP 的那份。
    const piFile = join(
      sessions,
      "2026-10-01T00-00-00-000Z_00000000-0000-4000-8000-000000000001.jsonl",
    );
    const ompFile = join(
      sessions,
      "2026-10-01T00-00-01-000Z_00000000-0000-4000-8000-000000000002.jsonl",
    );
    copyFileSync(join(fixtures, "session.jsonl"), piFile);
    copyFileSync(join(fixtures, "omp.jsonl"), ompFile);
    utimesSync(piFile, stamp, new Date(stamp.getTime() - 1000));
    utimesSync(ompFile, stamp, stamp);
  });

  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const hint = (agentId: string) => ({
    agentId,
    cwd: "/work/demo",
    startedAtMs: Date.now() - 1000,
  });

  it("attributes each file to the CLI that wrote it", () => {
    expect(piTranscript.locate(hint("pi"))).toMatch(/000000000001\.jsonl$/);
    expect(ompTranscript.locate(hint("omp"))).toMatch(/000000000002\.jsonl$/);
  });

  it("finds nothing rather than another writer's file", () => {
    rmSync(join(dir, "sessions", "--work-demo--"), { recursive: true });
    mkdirSync(join(dir, "sessions", "--work-demo--"));
    copyFileSync(
      join(__dirname, "fixtures", "pi", "omp.jsonl"),
      join(
        dir,
        "sessions",
        "--work-demo--",
        "2026-10-01T00-00-01-000Z_00000000-0000-4000-8000-000000000002.jsonl",
      ),
    );
    expect(piTranscript.locate(hint("pi"))).toBeUndefined();
    expect(ompTranscript.locate(hint("omp"))).toBeDefined();
  });

  it("trusts a path the extension reported", () => {
    const reported = join(
      dir,
      "sessions",
      "--work-demo--",
      "2026-10-01T00-00-01-000Z_00000000-0000-4000-8000-000000000002.jsonl",
    );
    expect(
      piTranscript.locate({ ...hint("pi"), transcriptPath: reported }),
    ).toBe(reported);
  });
});
