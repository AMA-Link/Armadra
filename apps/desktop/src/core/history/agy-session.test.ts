import { describe, expect, it } from "vitest";

import {
  type AgySessionDeps,
  agyPidsUnder,
  createdConversations,
  heldLogsOf,
  resolveAgySession,
  transcriptOf,
} from "./agy-session";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const LOG = "/h/.gemini/antigravity-cli/log/cli-20261125_021351.log";
const STATE = "/h/.gemini/antigravity-cli";

const line = (id: string) =>
  `I1125 02:13:51.634988  262 server.go:1269] Created conversation ${id} (backend=BACKEND_TYPE_UNSPECIFIED)`;

function deps(patch: Partial<AgySessionDeps> = {}): AgySessionDeps {
  return {
    platform: () => "darwin",
    agyPids: () => [42],
    heldLogs: () => [LOG],
    readLog: () => [line(A)].join("\n"),
    topLevel: (ids) => new Set(ids),
    stateDir: () => STATE,
    exists: () => true,
    ...patch,
  };
}

describe("createdConversations", () => {
  it("lists the ids in order of appearance, once each", () => {
    const text = [
      "noise",
      line(A),
      `GetConversationDetail: found conversation ${B} (active=true)`,
      line(B),
      line(A),
    ].join("\n");
    expect(createdConversations(text)).toEqual([A, B]);
    expect(createdConversations("nothing here")).toEqual([]);
  });
});

describe("resolveAgySession", () => {
  it("maps the process to the one conversation its log created", () => {
    expect(resolveAgySession(deps(), 7)).toEqual({
      sessionId: A,
      transcriptPath: `${STATE}/brain/${A}/.system_generated/logs/transcript.jsonl`,
      logPath: LOG,
    });
  });

  it("takes the last created conversation the index confirms as top level", () => {
    const text = [line(A), line(B), line(C)].join("\n");
    // C 是子代理（索引里没有）：不认，取最后一条已确认的 B。
    expect(
      resolveAgySession(
        deps({
          readLog: () => text,
          topLevel: (ids) => new Set(ids.filter((id) => id !== C)),
        }),
        7,
      )?.sessionId,
    ).toBe(B);
    // 全都没确认：不显示。
    expect(
      resolveAgySession(
        deps({ readLog: () => text, topLevel: () => new Set() }),
        7,
      ),
    ).toBeUndefined();
  });

  it("when the index cannot be read, only a single created conversation is used", () => {
    expect(
      resolveAgySession(deps({ topLevel: () => undefined }), 7)?.sessionId,
    ).toBe(A);
    expect(
      resolveAgySession(
        deps({
          readLog: () => [line(A), line(B)].join("\n"),
          topLevel: () => undefined,
        }),
        7,
      ),
    ).toBeUndefined();
  });

  it("degrades to nothing, without throwing, wherever a fact is missing", () => {
    expect(resolveAgySession(deps(), undefined)).toBeUndefined();
    expect(
      resolveAgySession(deps({ platform: () => "win32" }), 7),
    ).toBeUndefined();
    expect(
      resolveAgySession(deps({ agyPids: () => undefined }), 7),
    ).toBeUndefined();
    // 没有 agy 进程，或不止一个：不猜。
    expect(resolveAgySession(deps({ agyPids: () => [] }), 7)).toBeUndefined();
    expect(
      resolveAgySession(deps({ agyPids: () => [1, 2] }), 7),
    ).toBeUndefined();
    expect(
      resolveAgySession(deps({ heldLogs: () => undefined }), 7),
    ).toBeUndefined();
    expect(resolveAgySession(deps({ heldLogs: () => [] }), 7)).toBeUndefined();
    expect(
      resolveAgySession(deps({ heldLogs: () => [LOG, LOG + "2"] }), 7),
    ).toBeUndefined();
    expect(
      resolveAgySession(deps({ readLog: () => undefined }), 7),
    ).toBeUndefined();
    expect(
      resolveAgySession(deps({ readLog: () => "no conversation yet" }), 7),
    ).toBeUndefined();
    expect(
      resolveAgySession(deps({ stateDir: () => undefined }), 7),
    ).toBeUndefined();
  });
});

describe("transcriptOf", () => {
  it("prefers transcript.jsonl, falls back to transcript_full.jsonl when only that exists", () => {
    const logs = `${STATE}/brain/${A}/.system_generated/logs`;
    expect(transcriptOf(STATE, A, () => true)).toBe(`${logs}/transcript.jsonl`);
    expect(transcriptOf(STATE, A, () => false)).toBe(
      `${logs}/transcript.jsonl`,
    );
    expect(transcriptOf(STATE, A, (path) => path.endsWith("_full.jsonl"))).toBe(
      `${logs}/transcript_full.jsonl`,
    );
  });
});

describe("agyPidsUnder", () => {
  it("finds agy at or below the root, and nothing else", () => {
    const table = {
      parents: new Map([
        [10, 1],
        [11, 10],
        [12, 11],
        [20, 1],
        [21, 20],
      ]),
      names: new Map([
        [10, "tmux"],
        [11, "sh"],
        [12, "agy"],
        [20, "tmux"],
        [21, "agy"],
      ]),
    };
    expect(agyPidsUnder(table, 10)).toEqual([12]);
    expect(agyPidsUnder(table, 12)).toEqual([12]);
    expect(agyPidsUnder(table, 99)).toEqual([]);
  });
});

describe("heldLogsOf", () => {
  it("answers nothing for a process that does not exist, without throwing", () => {
    expect(() => heldLogsOf(2_147_483_000)).not.toThrow();
    const answer = heldLogsOf(2_147_483_000);
    expect(answer === undefined || answer.length === 0).toBe(true);
  });
});
