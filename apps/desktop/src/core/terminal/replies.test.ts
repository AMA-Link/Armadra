import { describe, expect, it } from "vitest";
import {
  MAX_REPLY_LENGTH,
  isTerminalReplyData,
  replyResponder,
} from "./replies";
import type { WindowViewer } from "./viewers";

describe("terminal reply data (#518)", () => {
  it("accepts what xterm answers to the queries it knows", () => {
    for (const reply of [
      "\x1b[?1;2c",
      "\x1b[>0;276;0c",
      "\x1b[1;1R",
      "\x1b[0n",
      "\x1b[?2004;2$y",
      "\x1b[8;24;80t",
      "\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\",
      "\x1b]4;1;rgb:cdcd/0000/0000\x07",
      "\x1bP1$r0m\x1b\\",
      // Several in one `onData`: DA1 and DA2 from one printf.
      "\x1b[?1;2c\x1b[>0;276;0c",
    ]) {
      expect(isTerminalReplyData(reply), JSON.stringify(reply)).toBe(true);
    }
  });

  it("refuses anything that could type a command", () => {
    for (const data of [
      "",
      "ls\r",
      "\x1b[?1;2cls\r",
      "\x1b[A",
      "\x1b[200~echo hi\x1b[201~",
      "\x1b]11;rgb:0/0/0\rrm -rf ~\x07",
      "\x1b]11;rgb:0/0/0",
      "\x1bP$q\x1b",
      "\x1b[?1;2",
      "\x1b",
      "\x1b" + "]" + "a".repeat(MAX_REPLY_LENGTH) + "\x07",
    ]) {
      expect(isTerminalReplyData(data), JSON.stringify(data)).toBe(false);
    }
  });
});

describe("the responder of a single-pty session (#518)", () => {
  const viewer = (
    id: number,
    cols = 80,
    rows = 24,
    readOnly = false,
  ): WindowViewer => ({
    id,
    actor: `d${id}`,
    cols,
    rows,
    ...(readOnly ? { readOnly } : {}),
  });
  const window = { cols: 80, rows: 24 };

  it("is the view that last typed", () => {
    expect(replyResponder([viewer(1), viewer(2)], window, 2)).toBe(2);
  });

  it("else the earliest view at the window's size, else the earliest", () => {
    expect(
      replyResponder([viewer(1, 40, 12), viewer(2), viewer(3)], window),
    ).toBe(2);
    expect(replyResponder([viewer(1, 40, 12), viewer(2, 50, 14)], window)).toBe(
      1,
    );
    // A driver that has gone is no longer one.
    expect(replyResponder([viewer(1), viewer(2)], window, 7)).toBe(1);
  });

  it("never elects a read-only view, whose terminal does not answer", () => {
    expect(replyResponder([viewer(1, 80, 24, true), viewer(2)], window)).toBe(
      2,
    );
    expect(
      replyResponder([viewer(1, 80, 24, true)], window, 1),
    ).toBeUndefined();
    expect(replyResponder([], window)).toBeUndefined();
  });
});
