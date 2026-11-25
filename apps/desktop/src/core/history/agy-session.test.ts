import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  AgySessionResolver,
  type AgySessionDeps,
  activeConversations,
  agyPidsUnder,
  createdConversations,
  heldLogsOf,
  lsofArguments,
  parseLsofNames,
  transcriptOf,
} from "./agy-session";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
/** 路径一律用 join 拼：Windows 上分隔符不是 `/`。 */
const STATE = join("/h", ".gemini", "antigravity-cli");
const LOG = join(STATE, "log", "cli-20261125_021351.log");

const created = (id: string) =>
  `I1125 02:13:51.634988     262 server.go:1269] Created conversation ${id} (backend=BACKEND_TYPE_UNSPECIFIED)`;
const streaming = (id: string) =>
  `I1125 02:13:52.549753     630 conversation_manager.go:1282] Streaming conversation ${id}`;
const sending = (id: string) =>
  `I1125 02:13:53.522165     630 server.go:1883] Sending user message to conversation ${id} (items=1, media=0)`;

interface Rig {
  deps: AgySessionDeps;
  resolver: AgySessionResolver;
  /** 日志文本；改它就是日志在长。 */
  log: { text: string };
  calls: Record<string, number>;
  index: Map<string, "top" | "child">;
  held: { value: string[] | undefined };
  agyPids: { value: number[] | undefined };
  indexReadable: { value: boolean };
}

function rig(patch: Partial<AgySessionDeps> = {}): Rig {
  const log = { text: "" };
  const calls: Record<string, number> = {};
  const count = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  const index = new Map<string, "top" | "child">();
  const held = { value: [LOG] as string[] | undefined };
  const agyPids = { value: [42] as number[] | undefined };
  const indexReadable = { value: true };
  const deps: AgySessionDeps = {
    platform: () => "darwin",
    agyPids: () => {
      count("ps");
      return agyPids.value;
    },
    heldLogs: async () => {
      count("lsof");
      return held.value;
    },
    logSize: () => {
      count("stat");
      return Buffer.byteLength(log.text);
    },
    readLogFrom: (_path, from) => {
      count("read");
      return Buffer.from(log.text).subarray(from);
    },
    classify: (ids) => {
      count("classify");
      if (!indexReadable.value) return undefined;
      const out = new Map<string, "top" | "child">();
      for (const id of ids) {
        const kind = index.get(id);
        if (kind !== undefined) out.set(id, kind);
      }
      return out;
    },
    stateDir: () => STATE,
    exists: () => true,
    ...patch,
  };
  return {
    deps,
    resolver: new AgySessionResolver(deps),
    log,
    calls,
    index,
    held,
    agyPids,
    indexReadable,
  };
}

describe("log lines", () => {
  it("anchors on the glog prefix and the source file, once per id", () => {
    const text = [
      "noise",
      created(A),
      `GetConversationDetail: found conversation ${B} (active=true)`,
      `the model said: Created conversation ${C}`,
      // 行首不是 glog 前缀：不算。
      `  server.go:1269] Created conversation ${C}`,
      created(B),
      created(A),
      "",
    ].join("\n");
    expect(createdConversations(text)).toEqual([A, B]);
    expect(createdConversations("nothing here")).toEqual([]);
  });

  it("reads who is speaking from Sending / Streaming lines, collapsing repeats", () => {
    const text = [
      streaming(A),
      sending(A),
      sending(B),
      `model quoted: Streaming conversation ${C}`,
      streaming(A),
    ].join("\n");
    expect(activeConversations(text)).toEqual([A, B, A]);
  });
});

describe("AgySessionResolver", () => {
  it("maps the process to the conversation its log created", async () => {
    const r = rig();
    r.index.set(A, "top");
    r.log.text = created(A) + "\n";
    expect(await r.resolver.resolve(7)).toEqual({
      sessionId: A,
      transcriptPath: join(
        STATE,
        "brain",
        A,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      ),
      logPath: LOG,
    });
  });

  it("the current session is who spoke last, so a resumed one (no Created line) is found", async () => {
    const r = rig();
    r.index.set(A, "top");
    r.log.text = [streaming(A), sending(A)].join("\n") + "\n";
    expect((await r.resolver.resolve(7))?.sessionId).toBe(A);
  });

  it("after /new the last one to speak wins; falls back to the last Created", async () => {
    const r = rig();
    r.index.set(A, "top");
    r.index.set(B, "top");
    r.log.text = [created(A), sending(A), created(B)].join("\n") + "\n";
    // B 刚创建、还没说话：当前仍按「最近说话」是 A。
    expect((await r.resolver.resolve(7))?.sessionId).toBe(A);
    r.log.text += [sending(B)].join("\n") + "\n";
    expect((await r.resolver.resolve(7))?.sessionId).toBe(B);
    const none = rig();
    none.index.set(A, "top");
    none.index.set(B, "top");
    none.log.text = [created(A), created(B)].join("\n") + "\n";
    expect((await none.resolver.resolve(7))?.sessionId).toBe(B);
  });

  it("never picks a subagent: a child is ignored for good, an unknown id is asked again later", async () => {
    const r = rig();
    r.index.set(A, "top");
    r.index.set(C, "child");
    r.log.text =
      [created(A), sending(A), created(C), sending(C)].join("\n") + "\n";
    expect((await r.resolver.resolve(7))?.sessionId).toBe(A);
    // 另一个 id 库里还没有：当前仍是 A；等它进了库并且是顶层才换。
    r.log.text += [created(B), sending(B)].join("\n") + "\n";
    expect((await r.resolver.resolve(7))?.sessionId).toBe(A);
    r.index.set(B, "top");
    r.log.text += streaming(B) + "\n";
    expect((await r.resolver.resolve(7))?.sessionId).toBe(B);
  });

  it("with nothing confirmed it shows nothing, and keeps asking while some id is unknown", async () => {
    const r = rig();
    r.log.text = created(A) + "\n";
    expect(await r.resolver.resolve(7)).toBeUndefined();
    // 日志没长，但还有未知 id：再问库，进了库就认。
    r.index.set(A, "top");
    expect((await r.resolver.resolve(7))?.sessionId).toBe(A);
  });

  it("when the index cannot be read, a single conversation is used and several are not", async () => {
    const r = rig();
    r.indexReadable.value = false;
    r.log.text = created(A) + "\n";
    expect((await r.resolver.resolve(7))?.sessionId).toBe(A);
    r.log.text += created(B) + "\n";
    expect(await r.resolver.resolve(7)).toBeUndefined();
  });

  it("steady state costs one ps and one stat: no lsof, no read, no index query", async () => {
    const r = rig();
    r.index.set(A, "top");
    r.log.text = created(A) + "\n";
    await r.resolver.resolve(7);
    for (const key of Object.keys(r.calls)) r.calls[key] = 0;
    for (let i = 0; i < 5; i += 1) {
      expect((await r.resolver.resolve(7))?.sessionId).toBe(A);
    }
    expect(r.calls).toMatchObject({
      ps: 5,
      stat: 5,
      lsof: 0,
      read: 0,
      classify: 0,
    });
  });

  it("reads only what was appended, and only asks the index about new ids", async () => {
    const r = rig();
    r.index.set(A, "top");
    r.index.set(B, "top");
    r.log.text = created(A) + "\n";
    await r.resolver.resolve(7);
    const classifyBefore = r.calls.classify ?? 0;
    const lengthBefore = Buffer.byteLength(r.log.text);
    r.log.text += sending(A) + "\n";
    const reads: number[] = [];
    const original = r.deps.readLogFrom;
    r.deps.readLogFrom = (path, from) => {
      reads.push(from);
      return original(path, from);
    };
    expect((await r.resolver.resolve(7))?.sessionId).toBe(A);
    expect(reads).toEqual([lengthBefore]);
    // A 早已分类：增量里没有新 id，不再查库。
    expect(r.calls.classify ?? 0).toBe(classifyBefore);
  });

  it("after /new, a session that reaches the index late is picked up even though the log no longer changes", async () => {
    const r = rig();
    r.index.set(A, "top");
    r.log.text =
      [created(A), sending(A), created(B), sending(B)].join("\n") + "\n";
    // B 是新会话，索引库里还没有：当前先停在 A。
    expect((await r.resolver.resolve(7))?.sessionId).toBe(A);
    // 库里的数据晚到，日志一个字节都没长：下一次问就换成 B。
    r.index.set(B, "top");
    expect((await r.resolver.resolve(7))?.sessionId).toBe(B);
    // 换过去之后稳态：不再查库。
    r.calls.classify = 0;
    expect((await r.resolver.resolve(7))?.sessionId).toBe(B);
    expect(r.calls.classify).toBe(0);
  });

  it("a half-written last line is read next time, not lost", async () => {
    const r = rig();
    r.index.set(A, "top");
    const line = created(A);
    r.log.text = line.slice(0, 30);
    expect(await r.resolver.resolve(7)).toBeUndefined();
    r.log.text = `${line}\n`;
    expect((await r.resolver.resolve(7))?.sessionId).toBe(A);
  });

  it("a truncated log is read again from the start", async () => {
    const r = rig();
    r.index.set(A, "top");
    r.index.set(B, "top");
    r.log.text = created(A) + "\n" + sending(A) + "\n";
    expect((await r.resolver.resolve(7))?.sessionId).toBe(A);
    r.log.text = created(B) + "\n";
    expect((await r.resolver.resolve(7))?.sessionId).toBe(B);
  });

  it("a log outside agy's own log directory is not the process's log", async () => {
    const r = rig();
    r.index.set(A, "top");
    r.log.text = created(A) + "\n";
    r.held.value = [join("/elsewhere", "antigravity-cli", "log", "cli-1.log")];
    expect(await r.resolver.resolve(7)).toBeUndefined();
    r.held.value = [LOG, join(STATE, "log", "cli-2.log")];
    expect(await r.resolver.resolve(7)).toBeUndefined();
  });

  it("degrades to nothing, without throwing, wherever a fact is missing", async () => {
    const r = rig();
    r.index.set(A, "top");
    r.log.text = created(A) + "\n";
    expect(await r.resolver.resolve(undefined)).toBeUndefined();
    const windows = rig({ platform: () => "win32" });
    expect(await windows.resolver.resolve(7)).toBeUndefined();
    r.agyPids.value = undefined;
    expect(await r.resolver.resolve(7)).toBeUndefined();
    r.agyPids.value = [];
    expect(await r.resolver.resolve(7)).toBeUndefined();
    r.agyPids.value = [1, 2];
    expect(await r.resolver.resolve(7)).toBeUndefined();
    r.agyPids.value = [42];
    const noLog = rig({ heldLogs: async () => undefined });
    noLog.log.text = created(A) + "\n";
    expect(await noLog.resolver.resolve(7)).toBeUndefined();
    const noStat = rig({ logSize: () => undefined });
    expect(await noStat.resolver.resolve(7)).toBeUndefined();
    const noStateDir = rig({ stateDir: () => undefined });
    expect(await noStateDir.resolver.resolve(7)).toBeUndefined();
    const noRead = rig({ readLogFrom: () => undefined });
    noRead.log.text = created(A) + "\n";
    expect(await noRead.resolver.resolve(7)).toBeUndefined();
  });

  it("a different agy process under the same root starts over", async () => {
    const r = rig();
    r.index.set(A, "top");
    r.log.text = created(A) + "\n";
    await r.resolver.resolve(7);
    r.agyPids.value = [99];
    for (const key of Object.keys(r.calls)) r.calls[key] = 0;
    await r.resolver.resolve(7);
    expect(r.calls.lsof).toBe(1);
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

describe("process table and lsof", () => {
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

  it("lsof runs without name resolution (-n -P) and for one pid only (-a -p)", () => {
    expect(lsofArguments(4242)).toEqual([
      "-n",
      "-P",
      "-a",
      "-p",
      "4242",
      "-Fn",
    ]);
  });

  it("keeps only agy's cli-*.log names out of lsof -Fn output", () => {
    const out = [
      "p4242",
      "fcwd",
      "n/tmp/project",
      "f3",
      `n${LOG}`,
      "f4",
      "n/Users/me/.gemini/antigravity-cli/conversation_summaries.db",
      "f5",
      "n/Users/me/.gemini/antigravity-cli/log/cli-20261125_021351.log",
      "f6",
      "nTCP 127.0.0.1:1->2 (ESTABLISHED)",
      `n${LOG}`,
    ].join("\n");
    expect(parseLsofNames(out)).toEqual([
      LOG,
      "/Users/me/.gemini/antigravity-cli/log/cli-20261125_021351.log",
    ]);
    expect(parseLsofNames("")).toEqual([]);
  });

  it("answers nothing for a process that does not exist, without throwing", async () => {
    const answer = await heldLogsOf(2_147_483_000);
    expect(answer === undefined || answer.length === 0).toBe(true);
  });
});
