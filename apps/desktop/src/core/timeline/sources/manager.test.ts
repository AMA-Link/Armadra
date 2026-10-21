import {
  appendFileSync,
  copyFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { insertSession } from "../../hook/fixture";
import { ingest } from "../../hook/ingest";
import { normalizeAs } from "../../hook/normalize";
import { FakeTimers } from "../testing";
import { type Rig, fixtureLines, rig } from "./harness";
import { SourceManager, transcriptAdapterFor } from "./index";
import { decodeCursor } from "./tailer";

const SESSION = "sess-1";

let dir: string;
let transcript: string;
let timers: FakeTimers;
let r: Rig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "armadra-src-"));
  transcript = join(dir, "claude.jsonl");
  timers = new FakeTimers();
  r = rig({
    timers,
    watch: () => ({ close() {} }),
  });
  insertSession(r.fixture, { id: SESSION, status: "running" });
});

afterEach(() => {
  r.close();
  rmSync(dir, { recursive: true, force: true });
});

const lines = fixtureLines("claude/session.jsonl");

function hook(payload: Record<string, unknown>, agent = "claude") {
  const event = normalizeAs(agent, agent, r.fixture.nodeId, {
    session_id: "cc-session",
    transcript_path: transcript,
    ...payload,
  });
  if (event === undefined) throw new Error("not understood");
  r.domain.sources.onHook(r.fixture.nodeId, event);
}

const itemIds = () => Object.keys(r.domain.writer.state(SESSION)?.items ?? {});

describe("hook → tailer → timeline", () => {
  it("shows transcript content within 200 ms of the hook and reports activity", () => {
    writeFileSync(transcript, lines.slice(0, 2).join("\n") + "\n");
    hook({ hook_event_name: "UserPromptSubmit", prompt: "跑一下测试并修复" });
    expect(r.domain.activity.get(SESSION)?.phase).toBe("submitting");
    timers.advance(200);
    expect(itemIds()).toContain("u:cc:u-001");
    expect(r.domain.store.get(SESSION)?.source).toBe("transcript");

    appendFileSync(transcript, lines.slice(2, 8).join("\n") + "\n");
    hook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "toolu_bash1",
      tool_input: { command: "pnpm test --run" },
    });
    expect(r.domain.activity.get(SESSION)).toMatchObject({
      phase: "tool",
      detail: { label: "Bash: pnpm test --run", toolKind: "execute" },
    });
    timers.advance(200);
    expect(itemIds()).toContain("tool:toolu_bash1");
  });

  it("closes the turn on Stop and goes idle with an outcome", () => {
    // 只有头两个回合里的前一半：回合没有收尾记录。
    writeFileSync(transcript, lines.slice(0, 5).join("\n") + "\n");
    hook({ hook_event_name: "UserPromptSubmit" });
    timers.advance(200);
    expect(
      r.domain.writer.state(SESSION)?.items["turn:cc:u-001"],
    ).toMatchObject({
      kind: "turn",
    });
    expect(
      (
        r.domain.writer.state(SESSION)?.items["turn:cc:u-001"] as {
          endedAt?: number;
        }
      ).endedAt,
    ).toBeUndefined();

    hook({ hook_event_name: "Stop" });
    expect(r.domain.activity.get(SESSION)).toMatchObject({
      phase: "idle",
      lastOutcome: { kind: "done" },
    });
    timers.advance(400);
    expect(
      r.domain.writer.state(SESSION)?.items["turn:cc:u-001"],
    ).toMatchObject({ stopReason: "end_turn" });
  });

  it("stores the agent title for auto-naming", () => {
    writeFileSync(transcript, lines.join("\n") + "\n");
    hook({ hook_event_name: "Stop" });
    timers.advance(400);
    expect(r.domain.writer.state(SESSION)?.head.title).toBe("修复测试");
  });

  it("persists the cursor so a restarted manager neither repeats nor loses lines", () => {
    writeFileSync(transcript, lines.slice(0, 12).join("\n") + "\n");
    hook({ hook_event_name: "UserPromptSubmit" });
    timers.advance(400);
    const cursor = decodeCursor(
      r.domain.store.get(SESSION)?.sourceCursor ?? "",
    );
    expect(cursor?.path).toBe(transcript);
    r.domain.writer.flush();
    const seqBefore = r.domain.store.get(SESSION)?.headSeq;

    // core 重启：新的管理器接着游标读。
    const again = new SourceManager(r.domain, {
      database: r.database,
      timers,
      watch: () => ({ close() {} }),
    });
    expect(again.resume()).toBe(1);
    const runner = again.runnerOf(SESSION);
    expect(runner?.currentCursor?.offset).toBe(cursor?.offset);
    timers.advance(400);
    r.domain.writer.flush();
    expect(r.domain.store.get(SESSION)?.headSeq).toBe(seqBefore);

    appendFileSync(transcript, lines.slice(12, 16).join("\n") + "\n");
    runner?.poke();
    timers.advance(400);
    expect(itemIds()).toContain("tool:toolu_write1");
    expect(itemIds().filter((id) => id === "tool:toolu_edit1")).toHaveLength(1);
    again.close();
  });

  it("starts over in the tail window when the transcript is rotated", () => {
    writeFileSync(transcript, lines.slice(0, 2).join("\n") + "\n");
    hook({ hook_event_name: "UserPromptSubmit" });
    timers.advance(400);
    renameSync(transcript, join(dir, "old.jsonl"));
    copyFileSync(join(dir, "old.jsonl"), join(dir, "copy.jsonl"));
    writeFileSync(
      transcript,
      JSON.stringify({
        type: "user",
        uuid: "new-1",
        timestamp: "2026-10-21T00:00:00.000Z",
        message: { role: "user", content: "换了新文件" },
      }) + "\n",
    );
    hook({ hook_event_name: "PostToolUse" });
    timers.advance(400);
    expect(itemIds()).toContain("u:cc:new-1");
  });

  it("does nothing for a node with no running terminal, or an agent without an adapter", () => {
    r.database.prepare("UPDATE terminal_sessions SET status = 'exited'").run();
    writeFileSync(transcript, lines.slice(0, 2).join("\n") + "\n");
    hook({ hook_event_name: "UserPromptSubmit" });
    timers.advance(400);
    expect(r.domain.store.get(SESSION)).toBeUndefined();
    expect(r.domain.sources.size).toBe(0);

    expect(transcriptAdapterFor("antigravity")).toBeUndefined();
    expect(transcriptAdapterFor("grok")).toBeUndefined();
    expect(transcriptAdapterFor("claude")?.agentId).toBe("claude");
    expect(transcriptAdapterFor("codex")?.agentId).toBe("codex");
  });

  it("stops tailing a session that is no longer running", () => {
    writeFileSync(transcript, lines.slice(0, 2).join("\n") + "\n");
    hook({ hook_event_name: "UserPromptSubmit" });
    expect(r.domain.sources.size).toBe(1);
    r.database.prepare("UPDATE terminal_sessions SET status = 'exited'").run();
    timers.advance(61_000);
    expect(r.domain.sources.size).toBe(0);
  });

  it("is rung by the ingest route after an accepted report", () => {
    const calls: string[] = [];
    const token = r.fixture.service.issueNodeToken(r.fixture.nodeId);
    const result = ingest(
      {
        ...r.fixture.context,
        onHook: (nodeId, event) => calls.push(`${nodeId}:${event.hookEvent}`),
      },
      "claude",
      {
        nodeId: r.fixture.nodeId,
        version: 1,
        payload: { hook_event_name: "UserPromptSubmit", prompt: "hi" },
      },
      {
        "x-armadra-hook-token": r.fixture.service.bearer(),
        "x-armadra-node-token": token,
      },
    );
    expect(result.status).toBe(204);
    expect(calls).toEqual([`${r.fixture.nodeId}:UserPromptSubmit`]);
  });
});
