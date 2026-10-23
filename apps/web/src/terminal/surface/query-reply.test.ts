import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";

import { trackQueryReplies } from "./query-reply";

/** 真的 xterm 解析器：查询进去，`onData` 出来的每一段都标上是不是应答。 */
function setup() {
  const term = new Terminal({ allowProposedApi: true });
  // 颜色报告由浏览器端的主题服务回答，要 `open()` 过才有。
  term.open(document.body.appendChild(document.createElement("div")));
  const replies = trackQueryReplies(term.parser);
  const seen: { data: string; reply: boolean }[] = [];
  term.onData((data) => seen.push({ data, reply: replies.isReply(data) }));
  const feed = (data: string) =>
    new Promise<void>((resolve) => term.write(data, resolve));
  /** 解析结束、微任务跑过之后：标记已经清掉。 */
  const idle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  return { term, replies, seen, feed, idle };
}

describe("query replies (#518)", () => {
  it("tags DA1, DA2 and CPR answers as replies", async () => {
    const { seen, feed } = setup();
    await feed("\x1b[c\x1b[>c\x1b[6n\x1b[5n");
    expect(seen).toEqual([
      { data: "\x1b[?1;2c", reply: true },
      { data: "\x1b[>0;276;0c", reply: true },
      { data: "\x1b[1;1R", reply: true },
      { data: "\x1b[0n", reply: true },
    ]);
  });

  it("tags mode reports, status strings and colour reports", async () => {
    const { seen, feed } = setup();
    await feed("\x1b[?2004$p\x1bP$qm\x1b\\\x1b]11;?\x07");
    expect(seen.map((entry) => entry.reply)).toEqual([true, true, true]);
    expect(seen[0]!.data).toBe("\x1b[?2004;2$y");
    expect(seen[2]!.data.startsWith("\x1b]11;rgb:")).toBe(true);
  });

  it("does not tag what a person types, even right after a query", async () => {
    const { term, seen, feed, idle } = setup();
    await feed("\x1b[c");
    await idle();
    term.input("ls\r");
    // F3 with Shift has the same shape as a cursor position report.
    term.input("\x1b[1;2R");
    expect(seen.slice(1)).toEqual([
      { data: "ls\r", reply: false },
      { data: "\x1b[1;2R", reply: false },
    ]);
  });

  it("leaves the terminal's own answers in place", async () => {
    const { seen, feed } = setup();
    // The hooks pass through: the set still lands (the report says #123456)
    // and the query is still answered.
    await feed("\x1b]10;#123456\x07\x1b]10;?\x07");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.data).toBe("\x1b]10;rgb:1212/3434/5656\x1b\\");
  });

  it("stops tagging once disposed", async () => {
    const { replies, seen, feed } = setup();
    replies.dispose();
    await feed("\x1b[c");
    expect(seen).toEqual([{ data: "\x1b[?1;2c", reply: false }]);
  });
});
