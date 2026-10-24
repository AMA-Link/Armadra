import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import type { Attachment } from "./backend";
import type { TerminalManager } from "./manager";
import {
  decodeFrame,
  encodeFrame,
  serveTerminalSocket,
  validWriter,
} from "./socket";

/**
 * The wire, as `apps/web/src/terminal/transport.ts` reads it.
 *
 * That file is the acceptance standard and may not change, so these tests are
 * written against what it parses rather than against what this side sends: the
 * frames are text, they are JSON objects, and every field it switches on is
 * present under the name it expects.
 */

describe("server frames", () => {
  it("encodes a text frame the page can JSON.parse", () => {
    const frame = encodeFrame({
      type: "hello",
      sessionId: "s1",
      generation: 2,
      backend: "tmux",
      rows: 24,
      cols: 80,
      alive: true,
      acknowledgedInput: 7,
    });
    expect(Buffer.isBuffer(frame)).toBe(true);
    const parsed = JSON.parse(frame.toString("utf8"));
    expect(parsed).toEqual({
      type: "hello",
      sessionId: "s1",
      generation: 2,
      backend: "tmux",
      rows: 24,
      cols: 80,
      alive: true,
      acknowledgedInput: 7,
    });
  });

  it("keeps escape sequences intact through the JSON envelope", () => {
    const data = "\u001b[1;32mok\u001b[0m\n";
    const parsed = JSON.parse(
      encodeFrame({ type: "output", data }).toString("utf8"),
    );
    expect(parsed.data).toBe(data);
  });

  it("carries a null exit code rather than omitting it", () => {
    const parsed = JSON.parse(
      encodeFrame({
        type: "status",
        status: "exited",
        exitCode: null,
      }).toString("utf8"),
    );
    expect(parsed).toEqual({
      type: "status",
      status: "exited",
      exitCode: null,
    });
  });

  it("names the current generation in a stale frame", () => {
    const parsed = JSON.parse(
      encodeFrame({ type: "stale", generation: 3 }).toString("utf8"),
    );
    expect(parsed).toEqual({ type: "stale", generation: 3 });
  });
});

describe("client frames", () => {
  it("accepts the three the page sends", () => {
    expect(decodeFrame('{"type":"input","data":"ls\\r","inputId":4}')).toEqual({
      type: "input",
      data: "ls\r",
      inputId: 4,
    });
    expect(decodeFrame('{"type":"resize","cols":100,"rows":40}')).toEqual({
      type: "resize",
      cols: 100,
      rows: 40,
    });
    expect(decodeFrame('{"type":"terminate","mode":"session"}')).toEqual({
      type: "terminate",
      mode: "session",
    });
  });

  it("treats a terminate with no mode as the parameterless one", () => {
    expect(decodeFrame('{"type":"terminate"}')).toEqual({ type: "terminate" });
    // An unknown mode is dropped rather than passed through: the three levels
    // are contractual and a fourth would reach the backend as a typo.
    expect(decodeFrame('{"type":"terminate","mode":"nuke"}')).toEqual({
      type: "terminate",
    });
  });

  /**
   * A malformed frame is a bug in a client, and the one thing a terminal
   * socket must not do is close over one: the pane is showing a running
   * process, and dropping the connection would look like the process died.
   */
  it("drops anything it cannot understand instead of answering", () => {
    expect(decodeFrame("not json")).toBeUndefined();
    expect(decodeFrame("null")).toBeUndefined();
    expect(decodeFrame("[]")).toBeUndefined();
    expect(decodeFrame('{"type":"input"}')).toBeUndefined();
    expect(decodeFrame('{"type":"input","data":42}')).toBeUndefined();
    expect(
      decodeFrame('{"type":"resize","cols":"80","rows":24}'),
    ).toBeUndefined();
    expect(decodeFrame('{"type":"whatever"}')).toBeUndefined();
  });

  it("keeps the reply mark only when it is literally true (#518)", () => {
    expect(
      decodeFrame('{"type":"input","data":"\\u001b[?1;2c","reply":true}'),
    ).toEqual({ type: "input", data: "\u001b[?1;2c", reply: true });
    expect(decodeFrame('{"type":"input","data":"a","reply":"yes"}')).toEqual({
      type: "input",
      data: "a",
    });
  });

  it("ignores an input id that is not a finite number", () => {
    expect(decodeFrame('{"type":"input","data":"a","inputId":"3"}')).toEqual({
      type: "input",
      data: "a",
    });
  });
});

describe("the writer label", () => {
  it("accepts an absent one as the empty label", () => {
    expect(validWriter(null)).toBe("");
    expect(validWriter("")).toBe("");
  });

  it("accepts ASCII graphic ids up to 64 characters", () => {
    expect(validWriter("node-7")).toBe("node-7");
    expect(validWriter("a".repeat(64))).toBe("a".repeat(64));
  });

  it("refuses anything longer, blank or non-graphic", () => {
    expect(validWriter("a".repeat(65))).toBeUndefined();
    expect(validWriter("has space")).toBeUndefined();
    expect(validWriter("newline\n")).toBeUndefined();
    expect(validWriter("中文")).toBeUndefined();
  });
});

/* ------------------------- the stream that ended -------------------------- */

/**
 * What a socket owes the page when its output stream ends.
 *
 * There are two reasons a stream ends and they call for opposite frames. The
 * session really finished: `status: exited`, and the row is settled. Or the
 * session was **recycled** underneath this socket — the recycle destroys the
 * old pane, which ends exactly this stream while the row is already running
 * again at the next generation. Telling the page `exited` there would show a
 * dead terminal for a live one, and settling the row would bury the session
 * that just replaced it.
 */
describe("a stream that ended", () => {
  function harness(currentGeneration: number) {
    const sent: Record<string, unknown>[] = [];
    let closed = false;
    let exit: ((code: number | undefined) => void) | undefined;
    const attachment: Attachment = {
      attachmentId: 1,
      generation: 1,
      onData: () => {},
      onExit: (listener) => {
        exit = listener;
      },
    };
    const marked: number[] = [];
    const handlers = new Map<string, () => void>();
    const manager = {
      attach: async () => ({
        attachment,
        record: { kind: "tmux" },
        snapshot: undefined,
        size: { cols: 80, rows: 24 },
      }),
      acknowledgedInput: () => 0,
      generation: () => currentGeneration,
      markExited: (_id: string, code: number | null) => marked.push(code ?? -1),
      noteOutput: () => {},
      queries: { output: () => {}, expects: () => false },
      detached: async () => {},
    } as unknown as TerminalManager;
    const connection = {
      readyState: 1,
      bufferedAmount: 0,
      send: (payload: Buffer) =>
        sent.push(
          JSON.parse(payload.toString("utf8")) as Record<string, unknown>,
        ),
      close: () => {
        closed = true;
        handlers.get("close")?.();
      },
      on: (event: string, handler: () => void) => {
        handlers.set(event, handler);
      },
    } as unknown as WebSocket;
    return {
      sent,
      marked,
      manager,
      connection,
      closed: () => closed,
      end: (code: number | undefined) => exit?.(code),
    };
  }

  it("reports an exit that really happened", async () => {
    const socket = harness(1);
    const served = serveTerminalSocket(socket.connection, {
      manager: socket.manager,
      sessionId: "s1",
      writer: "w",
    });
    await Promise.resolve();
    socket.end(3);
    await served;
    expect(socket.sent.at(-1)).toEqual({
      type: "status",
      status: "exited",
      exitCode: 3,
    });
    expect(socket.marked).toEqual([3]);
  });

  it("sends `stale` for a recycle, and settles nothing", async () => {
    const socket = harness(2);
    const served = serveTerminalSocket(socket.connection, {
      manager: socket.manager,
      sessionId: "s1",
      writer: "w",
    });
    await Promise.resolve();
    socket.end(undefined);
    await served;
    expect(socket.sent.at(-1)).toEqual({ type: "stale", generation: 2 });
    expect(socket.marked).toEqual([]);
    expect(socket.closed()).toBe(true);
  });
});

/**
 * 页面在 attach 还没完成时就关了（刚挂上画布就关掉、切走）。`close` 事件发在
 * 我们挂上监听之前，从来没有人去 `detached`：core 一直以为有人看着这个会话，
 * 节能休眠被「attached」挡住永远不睡（2026-09-26 全量端到端：关掉页面四分钟后
 * 三个会话仍是 attached）。
 */
describe("a socket that closes while it is still attaching", () => {
  it("still releases the attachment", async () => {
    const handlers = new Map<string, () => void>();
    let release: (() => void) | undefined;
    const detached: number[] = [];
    const attachment: Attachment = {
      attachmentId: 7,
      generation: 1,
      onData: () => {},
      onExit: () => {},
    };
    const manager = {
      attach: () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              attachment,
              record: { kind: "tmux" },
              snapshot: undefined,
              size: { cols: 80, rows: 24 },
            });
        }),
      acknowledgedInput: () => 0,
      generation: () => 1,
      noteOutput: () => {},
      queries: { output: () => {}, expects: () => false },
      detached: async (_id: string, attachmentId: number) => {
        detached.push(attachmentId);
      },
    } as unknown as TerminalManager;
    const connection = {
      readyState: 1,
      bufferedAmount: 0,
      send: () => {},
      close: () => {},
      on: (event: string, handler: () => void) => {
        handlers.set(event, handler);
      },
    } as unknown as WebSocket;
    const served = serveTerminalSocket(connection, {
      manager,
      sessionId: "s1",
      writer: "w",
    });
    // 页面走了：attach 还没回来。
    handlers.get("close")?.();
    release?.();
    await served;
    expect(detached).toEqual([7]);
  });
});

/**
 * 多端尺寸（ui-acp-refresh §7.3 E-1）：hello 报这一端自己的起始尺寸；resize 帧只作用于
 * 发出它的那一端；按键先记下是哪一端在驾驶。
 */
describe("a viewer's own size", () => {
  it("reports the viewer's size in the hello and scopes resizes to it", async () => {
    const sent: Record<string, unknown>[] = [];
    const handlers = new Map<string, (data?: unknown) => void>();
    const calls: unknown[][] = [];
    const attachment: Attachment = {
      attachmentId: 9,
      generation: 1,
      onData: () => {},
      onExit: () => {},
    };
    const manager = {
      attach: async (...args: unknown[]) => {
        calls.push(["attach", ...args]);
        return {
          attachment,
          record: { kind: "tmux" },
          snapshot: undefined,
          size: { cols: 132, rows: 43 },
        };
      },
      acknowledgedInput: () => 0,
      generation: () => 1,
      noteOutput: () => {},
      queries: { output: () => {}, expects: () => false },
      noteViewerInput: (...args: unknown[]) =>
        calls.push(["noteViewerInput", ...args]),
      input: async () => calls.push(["input"]),
      resize: async (...args: unknown[]) => calls.push(["resize", ...args]),
      detached: async () => {},
    } as unknown as TerminalManager;
    const connection = {
      readyState: 1,
      bufferedAmount: 0,
      send: (payload: Buffer) =>
        sent.push(
          JSON.parse(payload.toString("utf8")) as Record<string, unknown>,
        ),
      close: () => handlers.get("close")?.(),
      on: (event: string, handler: (data?: unknown) => void) => {
        handlers.set(event, handler);
      },
    } as unknown as WebSocket;
    const served = serveTerminalSocket(connection, {
      manager,
      sessionId: "s1",
      writer: "phone",
    });
    await new Promise((resolve) => setImmediate(resolve));
    // No size in the request: the manager decides where the viewer starts.
    expect(calls[0]).toEqual(["attach", "s1", undefined, "phone", false]);
    expect(sent[0]).toMatchObject({ type: "hello", cols: 132, rows: 43 });

    handlers.get("message")?.(
      JSON.stringify({ type: "resize", cols: 40, rows: 12 }),
    );
    handlers.get("message")?.(JSON.stringify({ type: "input", data: "x" }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toContainEqual([
      "resize",
      "s1",
      1,
      { cols: 40, rows: 12 },
      9,
    ]);
    const order = calls.map((call) => call[0]);
    expect(order.indexOf("noteViewerInput")).toBeLessThan(
      order.indexOf("input"),
    );
    connection.close();
    await served;
  });
});

describe("a view answering a query (#518)", () => {
  async function serve(
    sent: Record<string, unknown> | Record<string, unknown>[],
    owed = false,
    feed: [string, boolean?][] = [],
  ) {
    const frames = Array.isArray(sent) ? sent : [sent];
    let emit: ((chunk: Buffer, replay?: boolean) => void) | undefined;
    const handlers = new Map<string, (data?: unknown) => void>();
    const calls: unknown[][] = [];
    const attachment: Attachment = {
      attachmentId: 9,
      generation: 1,
      onData: (listener) => {
        emit = listener;
      },
      onExit: () => {},
    };
    const manager = {
      attach: async () => ({
        attachment,
        record: { kind: "direct" },
        snapshot: undefined,
        size: { cols: 80, rows: 24 },
      }),
      acknowledgedInput: () => 0,
      generation: () => 1,
      noteOutput: () => {},
      queries: {
        output: (_session: string, _view: number, text: string) =>
          calls.push(["output", text]),
        seed: (_session: string, _view: number, text: string) =>
          calls.push(["seed", text]),
        expects: () => owed,
      },
      noteInputApplied: (...args: unknown[]) =>
        calls.push(["noteInputApplied", ...args]),
      noteViewerInput: (...args: unknown[]) =>
        calls.push(["noteViewerInput", ...args]),
      input: async (...args: unknown[]) => calls.push(["input", ...args]),
      reply: async (...args: unknown[]) => {
        calls.push(["reply", ...args]);
        return true;
      },
      detached: async () => {},
    } as unknown as TerminalManager;
    const connection = {
      readyState: 1,
      bufferedAmount: 0,
      send: () => {},
      close: () => handlers.get("close")?.(),
      on: (event: string, handler: (data?: unknown) => void) => {
        handlers.set(event, handler);
      },
    } as unknown as WebSocket;
    const served = serveTerminalSocket(connection, {
      manager,
      sessionId: "s1",
      writer: "phone",
    });
    await new Promise((resolve) => setImmediate(resolve));
    for (const [text, replay] of feed) emit?.(Buffer.from(text), replay);
    for (const frame of frames) {
      handlers.get("message")?.(JSON.stringify(frame));
      await new Promise((resolve) => setImmediate(resolve));
    }
    connection.close();
    await served;
    return calls;
  }

  it("hands a reply to the manager as one, without driving", async () => {
    const calls = await serve({
      type: "input",
      data: "\u001b[?1;2c\u001b[>0;276;0c",
      reply: true,
    });
    expect(calls).toEqual([
      ["reply", "s1", 1, "\u001b[?1;2c\u001b[>0;276;0c", 9],
    ]);
  });

  it("treats a marked frame that is not a reply as typing", async () => {
    const calls = await serve({
      type: "input",
      data: "rm -rf ~\r",
      reply: true,
    });
    expect(calls.map((call) => call[0])).toEqual(["noteViewerInput", "input"]);
  });

  it("takes an unmarked reply while a query is owed, and acknowledges it", async () => {
    const calls = await serve(
      { type: "input", data: "\u001b[?1;2c", inputId: 4 },
      true,
    );
    expect(calls.map((call) => call[0])).toEqual(["reply", "noteInputApplied"]);
  });

  it("types an unmarked reply-shaped input when nothing is owed", async () => {
    // Shift+F3 arrives as a cursor-report shaped sequence.
    const calls = await serve({ type: "input", data: "\u001b[1;2R" });
    expect(calls.map((call) => call[0])).toEqual(["noteViewerInput", "input"]);
  });

  it("still types an unmarked input that is not all reply while one is owed", async () => {
    const calls = await serve(
      { type: "input", data: "\u001b[?1;2cls\r" },
      true,
    );
    expect(calls.map((call) => call[0])).toEqual(["noteViewerInput", "input"]);
  });

  it("counts live output as queries but not the replay of an attach", async () => {
    const calls = await serve([], false, [["\u001b[c", true], ["\u001b[>c"]]);
    // The replay is not a question, but its tail may be half of one.
    expect(calls).toEqual([
      ["seed", "\u001b[c"],
      ["output", "\u001b[>c"],
    ]);
  });

  it("stops guessing once a page has marked a reply", async () => {
    const reply = "\u001b[?1;2c";
    const calls = await serve(
      [
        { type: "input", data: reply, reply: true },
        // Shift+F3 looks like a cursor report, and a page that marks its
        // replies is telling us this is a key.
        { type: "input", data: "\u001b[1;2R" },
      ],
      true,
    );
    expect(calls.map((call) => call[0])).toEqual([
      "reply",
      "noteViewerInput",
      "input",
    ]);
  });
});
