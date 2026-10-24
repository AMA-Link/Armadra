import { describe, expect, it } from "vitest";
import { MAX_REPLY_LENGTH, isTerminalReplyData } from "./replies";

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
