import { describe, expect, it } from "vitest";
import { QueryLedger, REPLY_WINDOW_MS, scanQueries } from "./reply-ledger";

describe("the queries in a program's output (#518)", () => {
  it("finds every kind xterm answers", () => {
    const text =
      "\x1b[c\x1b[0c\x1b[>c\x1b[>0c\x1b[5n\x1b[6n\x1b[?6n\x1b[?15n" +
      "\x1b[?2004$p\x1b[4$p\x1b[14t\x1bP$qm\x1b\\" +
      "\x1b]10;?\x07\x1b]11;?\x1b\\\x1b]4;1;?;2;?\x07\x1b]10;?;?\x07";
    expect(scanQueries(text)).toEqual({
      kinds: [
        "da1",
        "da1",
        "da2",
        "da2",
        "dsr",
        "cpr",
        "cpr",
        "dsr",
        "decrpm",
        "decrpm",
        "winops",
        "decrqss",
        "osc10",
        "osc11",
        "osc4",
        "osc4",
        "osc10",
        "osc11",
      ],
      rest: "",
    });
  });

  it("ignores sequences that are not queries", () => {
    const text =
      "\x1b[31mred\x1b[0m \x1b[2J\x1b]0;title\x07\x1b[1;5H\x1b]11;rgb:0/0/0\x07";
    expect(scanQueries(text).kinds).toEqual([]);
  });

  it("hands back the unfinished end for the next chunk", () => {
    expect(scanQueries("hi\x1b[>0")).toEqual({ kinds: [], rest: "\x1b[>0" });
    expect(scanQueries("a\x1b")).toEqual({ kinds: [], rest: "\x1b" });
    expect(scanQueries("\x1b]11;?")).toEqual({ kinds: [], rest: "\x1b]11;?" });
    expect(scanQueries("\x1b]11;?\x1b")).toEqual({
      kinds: [],
      rest: "\x1b]11;?\x1b",
    });
    expect(scanQueries("\x1bP$q")).toEqual({ kinds: [], rest: "\x1bP$q" });
  });

  it("does not keep a runaway sequence", () => {
    expect(scanQueries("\x1b]" + "a".repeat(2000)).rest).toBe("");
  });
});

describe("the ledger of pending queries (#518)", () => {
  const DA = "\x1b[?1;2c";
  function ledger() {
    const time = { now: 1000 };
    const book = new QueryLedger(() => time.now);
    book.attach("s", 1);
    book.attach("s", 2);
    return { book, time };
  }

  it("takes the first answer and drops the second", () => {
    const { book } = ledger();
    book.output("s", 1, "\x1b[c");
    book.output("s", 2, "\x1b[c");
    expect(book.accept("s", 2, DA)).toBe(DA);
    expect(book.accept("s", 1, DA)).toBe("");
  });

  it("follows a view that lags behind the other", () => {
    const { book } = ledger();
    book.output("s", 1, "\x1b[c");
    expect(book.accept("s", 1, DA)).toBe(DA);
    // View 2 only now sees that query and answers late: already answered.
    book.output("s", 2, "\x1b[c");
    expect(book.accept("s", 2, DA)).toBe("");
    // The next query is a new one for both.
    book.output("s", 1, "\x1b[c");
    book.output("s", 2, "\x1b[c");
    expect(book.accept("s", 2, DA)).toBe(DA);
    expect(book.accept("s", 1, DA)).toBe("");
  });

  it("keeps the kinds apart", () => {
    const { book } = ledger();
    book.output("s", 1, "\x1b[c\x1b[6n");
    book.output("s", 2, "\x1b[c\x1b[6n");
    expect(book.accept("s", 1, DA)).toBe(DA);
    expect(book.accept("s", 2, "\x1b[3;4R")).toBe("\x1b[3;4R");
    expect(book.accept("s", 1, "\x1b[3;4R")).toBe("");
  });

  it("passes the replies it cannot tell apart through", () => {
    const { book } = ledger();
    expect(book.accept("s", 1, "\x1b]lTitle\x1b\\")).toBe("\x1b]lTitle\x1b\\");
  });

  it("refuses an answer after the window, and forgives the debt", () => {
    const { book, time } = ledger();
    book.output("s", 1, "\x1b[c");
    book.output("s", 2, "\x1b[c");
    time.now += REPLY_WINDOW_MS + 1;
    expect(book.accept("s", 1, DA)).toBe("");
    // A new query long after the unanswered one: answered normally.
    book.output("s", 1, "\x1b[c");
    book.output("s", 2, "\x1b[c");
    expect(book.accept("s", 2, DA)).toBe(DA);
    expect(book.accept("s", 1, DA)).toBe("");
  });

  it("does not expire an answer while a single view is attached", () => {
    const time = { now: 1000 };
    const book = new QueryLedger(() => time.now);
    book.attach("s", 1);
    book.output("s", 1, "\x1b[c");
    time.now += REPLY_WINDOW_MS * 10;
    expect(book.accept("s", 1, DA)).toBe(DA);
    // With a second view the window applies again.
    book.attach("s", 2);
    book.output("s", 1, "\x1b[c");
    book.output("s", 2, "\x1b[c");
    time.now += REPLY_WINDOW_MS + 1;
    expect(book.accept("s", 1, DA)).toBe("");
  });

  it("says whether a reply is owed, for senders that do not mark it", () => {
    const { book } = ledger();
    expect(book.expects("s", 1, DA)).toBe(false);
    book.output("s", 1, "\x1b[c");
    expect(book.expects("s", 1, DA)).toBe(true);
    expect(book.expects("s", 2, DA)).toBe(false);
    // Shift+F3 looks like a cursor report, but nothing asked for one.
    expect(book.expects("s", 1, "\x1b[1;2R")).toBe(false);
    expect(book.expects("s", 1, "ls\r")).toBe(false);
    book.accept("s", 1, DA);
    expect(book.expects("s", 1, DA)).toBe(false);
  });
});
