import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture, callerFor } from "../agent/fixture";
import { rfc3339, uuidV7 } from "../workspaces/support";
import { noteRead } from "./context-reads";
import { DEFAULT_CONTENT_BYTES, runContextLink } from "./context-link";
import { READ_BUDGET_MINUTE_BYTES } from "./read-budget";
import { Args, Refusal, Refused } from "./refusals";

/**
 * 一段一段地读（#668）：每次读取先看这条连线还剩多少额度，只给装得下的那一段，
 * 再附上接着读的那个参数——文件用 `--offset`，转录往前翻用 `--before`。
 *
 * 与 `context-budget.test.ts` 分开：那一份守的是每个动词自己的上限与审计，这一
 * 份守的是「上限之间对得上」与「续读接得上」。
 */

let fixture: AgentFixture;
let me: string;

async function read(
  verb: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  return runContextLink(
    fixture.collab,
    callerFor(fixture, me),
    verb,
    new Args(args),
  );
}

function editor(title: string, file: string, text: string | Buffer): string {
  writeFileSync(join(fixture.directory, file), text);
  const id = uuidV7();
  const now = rfc3339();
  fixture.database
    .prepare(
      "INSERT INTO nodes (id, board_id, type, title, color, x, y, width, height, " +
        "labels_json, note, data_json, created_at, updated_at) " +
        "VALUES (?, ?, 'editor', ?, '#0a84ff', 0, 0, 240, 200, '[]', '', ?, ?, ?)",
    )
    .run(
      id,
      fixture.boardId,
      title,
      JSON.stringify({ kind: "editor", path: file }),
      now,
      now,
    );
  fixture.link(me, id);
  return id;
}

function peerWithTranscript(count: number): string {
  const peer = fixture.agentNode("Peer");
  fixture.link(me, peer);
  const path = join(fixture.directory, "peer.jsonl");
  writeFileSync(
    path,
    Array.from({ length: count }, (_value, index) =>
      JSON.stringify({
        type: "user",
        message: { role: "user", content: `第${index}条` },
      }),
    ).join("\n") + "\n",
  );
  fixture.database
    .prepare(
      "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, unread, verified, restored, updated_at, transcript_path) " +
        "VALUES (?, ?, 'claude', 'idle', 0, 1, 0, ?, ?)",
    )
    .run(peer, fixture.workspaceId, rfc3339(), path);
  return peer;
}

/** 把这条连线一分钟的额度先花掉，只剩 `left` 字节。 */
function spendAllBut(target: string, left: number): void {
  noteRead(
    fixture.database,
    {
      reader: me,
      target,
      verb: "transcript",
      bytes: READ_BUDGET_MINUTE_BYTES - left,
    },
    Date.now(),
  );
}

/** 正文：去掉文件头那一行与页脚。 */
function fileBody(reply: string): string {
  const start = reply.indexOf("：\n\n") + 3;
  const footer = reply.indexOf("\n\n接着读");
  const budget = reply.indexOf("\n（这条连线");
  const ends = [footer, budget].filter((at) => at >= 0);
  const end = ends.length === 0 ? reply.length : Math.min(...ends);
  return reply.slice(start, end).replace(/\n$/, "");
}

/** 回复里给出的下一个 `--offset`。 */
function nextOffset(reply: string): number | undefined {
  const match = /--offset (\d+)/.exec(reply);
  return match === null ? undefined : Number(match[1]);
}

beforeEach(() => {
  fixture = agentFixture();
  me = fixture.agentNode("Caller");
});

afterEach(() => {
  fixture.close();
});

describe("文件一段一段地给", () => {
  it("缺省只给 32 KB，说出字节范围与接着读的 --offset", async () => {
    editor("Big", "big.txt", "a".repeat(100 * 1024));
    const reply = await read("transcript", { node: "Big" });
    expect(reply).toContain(`第 0–${DEFAULT_CONTENT_BYTES} 字节`);
    expect(reply).toContain(`--offset ${DEFAULT_CONTENT_BYTES}`);
    expect(fileBody(reply).length).toBe(DEFAULT_CONTENT_BYTES);
  });

  it("按 --offset 接下去，拼回来逐字节是原文件（多字节字符不被切开）", async () => {
    // 每个字三字节，32 KB 不是 3 的倍数：截断点必然落在字符中间。
    const original = "汉字abc\n".repeat(8_000);
    editor("Han", "han.txt", original);
    let rebuilt = "";
    let offset: number | undefined = 0;
    let pages = 0;
    while (offset !== undefined) {
      // 每一页之间额度回满：这里守的是接缝，不是预算。
      fixture.database.prepare("DELETE FROM context_reads").run();
      const reply = await read("transcript", { node: "Han", offset });
      const body = fileBody(reply);
      expect(body).not.toContain("�");
      rebuilt += body;
      offset = nextOffset(reply);
      pages += 1;
      if (offset !== undefined) {
        // 下一页从这一页的末字节接着开始。
        expect(Buffer.byteLength(rebuilt, "utf8")).toBe(offset);
      }
    }
    expect(pages).toBeGreaterThan(1);
    expect(rebuilt).toBe(original.trimEnd());
  });

  it("手写的 --offset 落在字符中间时挪到下一个字符开头", async () => {
    editor("Mid", "mid.txt", "汉字");
    const reply = await read("transcript", { node: "Mid", offset: 1 });
    expect(fileBody(reply)).toBe("字");
    expect(reply).toContain("第 3–6 字节");
  });

  it("剩余额度比一段少时只给剩下的，并照实说预算", async () => {
    const id = editor("Tight", "tight.txt", "b".repeat(100 * 1024));
    spendAllBut(id, 10 * 1024);
    const reply = await read("transcript", { node: "Tight" });
    expect(reply).toContain("读取预算只剩约 10 KB");
    expect(fileBody(reply).length).toBe(10 * 1024);
    expect(reply).toContain("--offset 10240");
  });

  it("剩下不到 2 KB 就照旧回 RATE_LIMITED", async () => {
    const id = editor("Spent", "spent.txt", "c".repeat(10 * 1024));
    spendAllBut(id, 1024);
    let refused: unknown;
    try {
      await read("transcript", { node: "Spent" });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(Refused);
    expect((refused as Refused).code).toBe("RATE_LIMITED");
  });
});

describe("转录往前翻页", () => {
  it("--before 一页页往前，条目不重不漏", async () => {
    peerWithTranscript(50);
    const seen: number[] = [];
    let reply = await read("transcript", { node: "Peer" });
    for (;;) {
      const page = [...reply.matchAll(/^\[用户\] 第(\d+)条$/gm)].map((match) =>
        Number(match[1]),
      );
      seen.unshift(...page);
      const next = /--before (\d+)/.exec(reply);
      if (next === null) break;
      fixture.database.prepare("DELETE FROM context_reads").run();
      reply = await read("transcript", {
        node: "Peer",
        before: Number(next[1]),
      });
    }
    expect(seen).toEqual(Array.from({ length: 50 }, (_value, index) => index));
    // 翻旧页不动 `--since` 的游标：第一次（最近的）读取之后没有新条目。
    const since = await read("transcript", { node: "Peer", since: true });
    expect(since).toContain("没有新条目");
  });

  it("页脚列出紧挨着的几条首行，最近的在最后", async () => {
    peerWithTranscript(30);
    const reply = await read("transcript", { node: "Peer" });
    expect(reply).toContain("更早还有 10 条");
    const glimpses = [...reply.matchAll(/^ {2}- \[用户\] 第(\d+)条$/gm)].map(
      (match) => Number(match[1]),
    );
    expect(glimpses).toEqual([5, 6, 7, 8, 9]);
  });

  it("没有更早的就不给页脚", async () => {
    peerWithTranscript(5);
    const reply = await read("transcript", { node: "Peer" });
    expect(reply).not.toContain("更早还有");
    expect(reply).not.toContain("--before");
  });

  it("--since 与 --before 不能一起用", async () => {
    peerWithTranscript(5);
    let refused: unknown;
    try {
      await read("transcript", { node: "Peer", since: true, before: 10 });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(Refusal);
    expect((refused as Refusal).status).toBe(400);
  });

  it("剩余额度装不下时整次回复落在额度之内", async () => {
    const peer = fixture.agentNode("Peer");
    fixture.link(me, peer);
    const path = join(fixture.directory, "wide.jsonl");
    writeFileSync(
      path,
      Array.from({ length: 40 }, () =>
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: "宽".repeat(1_500) },
        }),
      ).join("\n") + "\n",
    );
    fixture.database
      .prepare(
        "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, unread, verified, restored, updated_at, transcript_path) " +
          "VALUES (?, ?, 'claude', 'idle', 0, 1, 0, ?, ?)",
      )
      .run(peer, fixture.workspaceId, rfc3339(), path);
    spendAllBut(peer, 12 * 1024);
    const reply = await read("transcript", { node: "Peer", n: 40 });
    expect(reply).toContain("读取预算只剩约");
    expect(Buffer.byteLength(reply, "utf8")).toBeLessThanOrEqual(12 * 1024);
  });
});
