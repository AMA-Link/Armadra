import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  agyToolKind,
  agyTranscript,
  agyTranscriptWith,
  resultTextOf,
  userRequestOf,
} from "./agy";
import { convertAll, fixtureLines } from "./harness";
import { ADAPTERS } from "./index";

/**
 * 合成的 Antigravity 转录（形状取自 1.5.16 的 `transcript.jsonl`，内容是编的）→ 时间线。
 * 完整条目序列固定在 `fixtures/agy/transcript.expected.json`（`vitest -u` 更新）。
 */

const lines = fixtureLines("agy/transcript.jsonl");

/** 路径一律用 join 拼：Windows 上分隔符不是 `/`。 */
const HOME_STATE = join("/home", "me", ".gemini", "antigravity-cli");
const STATE = join("/h", ".gemini", "antigravity-cli");

describe("agy transcript → timeline", () => {
  const { items, head } = convertAll(agyTranscript, lines);

  it("matches the recorded conversion", async () => {
    await expect(
      JSON.stringify({ head, items }, null, 2) + "\n",
    ).toMatchFileSnapshot("./fixtures/agy/transcript.expected.json");
  });

  it("is registered under the base agent id", () => {
    expect(ADAPTERS.agy).toBe(agyTranscript);
  });

  it("makes a turn per user request, with the request text and not the metadata", () => {
    const turns = items.filter((item) => item.kind === "turn");
    expect(turns).toHaveLength(2);
    const users = items.filter((item) => item.kind === "user");
    expect(
      users.map((item) => (item.kind === "user" ? item.text : "")),
    ).toEqual([
      "Create a file p0.txt containing hi, then run pwd",
      "Now run a command that fails",
    ]);
  });

  it("closes a turn on the response that has no tool calls", () => {
    const turns = items.filter((item) => item.kind === "turn");
    for (const turn of turns) {
      expect(turn.kind === "turn" && turn.stopReason).toBe("end_turn");
    }
  });

  it("pairs results with calls in order, and reads the exit code", () => {
    const tools = items.filter((item) => item.kind === "tool");
    expect(tools).toHaveLength(4);
    const [pwd, write, ls, read] = tools;
    expect(pwd).toMatchObject({ toolKind: "execute", status: "completed" });
    expect(write).toMatchObject({ toolKind: "edit", status: "completed" });
    // 同一步里两个并行调用：第一条结果配给第一个调用（有退出码 2），第二条配给第二个。
    expect(ls).toMatchObject({ toolKind: "execute", status: "failed" });
    expect(read).toMatchObject({ toolKind: "read", status: "completed" });
  });

  it("keeps thinking, drops system reminders", () => {
    expect(items.filter((item) => item.kind === "thought")).toHaveLength(1);
    expect(JSON.stringify(items)).not.toContain(
      "not actually sent by the user",
    );
  });

  it("ignores what it does not recognise and never throws", () => {
    for (const bad of [
      "null",
      "[]",
      '{"type":"USER_INPUT"}',
      '{"step_index":1,"type":"SOMETHING_NEW"}',
      '{"step_index":1,"type":"GENERIC","content":"orphan result"}',
    ]) {
      expect(() => convertAll(agyTranscript, [bad])).not.toThrow();
    }
  });
});

describe("agy helpers", () => {
  it("userRequestOf takes the request, or the whole text", () => {
    expect(userRequestOf("<USER_REQUEST>\nhello\n</USER_REQUEST>\nmeta")).toBe(
      "hello",
    );
    expect(userRequestOf("plain")).toBe("plain");
  });

  it("resultTextOf drops the timestamp lines", () => {
    expect(
      resultTextOf(
        "Created At: a\nCompleted At: b\nCommand exited with code 0.",
      ),
    ).toBe("Command exited with code 0.");
  });

  it("tool kinds by name, MCP tools are other", () => {
    expect(agyToolKind("run_command")).toBe("execute");
    expect(agyToolKind("read_file")).toBe("read");
    expect(agyToolKind("write_file")).toBe("edit");
    expect(agyToolKind("grep_search")).toBe("search");
    expect(agyToolKind("mcp_armadra_canvas_list")).toBe("other");
  });

  it("locates the transcript from the hint, else from the session id", () => {
    const adapter = agyTranscriptWith({
      platform: () => "darwin",
      agyPids: () => undefined,
      heldLogs: async () => undefined,
      logSize: () => undefined,
      readLogFrom: () => undefined,
      classify: () => undefined,
      stateDir: () => HOME_STATE,
      exists: () => false,
    });
    expect(
      adapter.locate({ agentId: "agy", transcriptPath: "/x/t.jsonl" }),
    ).toBe("/x/t.jsonl");
    expect(adapter.locate({ agentId: "agy", sessionId: "abc" })).toBe(
      join(
        HOME_STATE,
        "brain",
        "abc",
        ".system_generated",
        "logs",
        "transcript.jsonl",
      ),
    );
    expect(adapter.locate({ agentId: "agy" })).toBeUndefined();
  });

  it("discover answers nothing for a remote node", async () => {
    const id = "11111111-2222-3333-4444-555555555555";
    const adapter = agyTranscriptWith({
      platform: () => "darwin",
      agyPids: () => [1],
      heldLogs: async () => [join(STATE, "log", "cli-1.log")],
      logSize: () => 100,
      readLogFrom: () =>
        Buffer.from(
          `I1125 02:13:51.634988     262 server.go:1269] Created conversation ${id} (backend=X)\n`,
        ),
      classify: (ids) => new Map(ids.map((one) => [one, "top" as const])),
      stateDir: () => STATE,
      exists: () => true,
    });
    expect(
      await adapter.discover?.({
        pid: 7,
        remote: true,
        cwd: "/w",
        startedAtMs: 0,
      }),
    ).toBeUndefined();
    expect(
      await adapter.discover?.({
        pid: 7,
        remote: false,
        cwd: "/w",
        startedAtMs: 0,
      }),
    ).toMatchObject({ sessionId: id });
  });
});
