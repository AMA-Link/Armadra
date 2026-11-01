import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { guardConsolePipes, isBrokenConsolePipe } from "./broken-pipe";

/**
 * The host owns every ConPTY of the user, so an exception node-pty throws
 * from one console's teardown must not end the others (#659). Only pipe
 * errors are survived; everything else still stops the process.
 */

function errno(message: string, code: string, syscall?: string): Error {
  return Object.assign(new Error(message), {
    code,
    ...(syscall === undefined ? {} : { syscall }),
  });
}

describe("isBrokenConsolePipe", () => {
  it("accepts the errors a ConPTY pipe raises when its console goes away", () => {
    expect(isBrokenConsolePipe(errno("read EPIPE", "EPIPE", "read"))).toBe(
      true,
    );
    expect(
      isBrokenConsolePipe(errno("read ECONNRESET", "ECONNRESET", "read")),
    ).toBe(true);
    expect(
      isBrokenConsolePipe(errno("write UNKNOWN", "UNKNOWN", "write")),
    ).toBe(true);
    expect(isBrokenConsolePipe(errno("write EPIPE", "EPIPE"))).toBe(true);
  });

  /**
   * An error from node-pty's conout worker is re-created on this thread, and
   * its message is the part that is sure to survive the copy.
   */
  it("recognises a pipe error by its message when the code was lost", () => {
    expect(isBrokenConsolePipe(new Error("read EPIPE"))).toBe(true);
    expect(isBrokenConsolePipe(new Error("write ECONNRESET"))).toBe(true);
  });

  it("refuses everything else", () => {
    expect(isBrokenConsolePipe(new TypeError("x is not a function"))).toBe(
      false,
    );
    expect(isBrokenConsolePipe(errno("listen EADDRINUSE", "EADDRINUSE"))).toBe(
      false,
    );
    // A pipe code from something that is not a read or a write.
    expect(
      isBrokenConsolePipe(errno("connect EPIPE", "EPIPE", "connect")),
    ).toBe(false);
    expect(isBrokenConsolePipe(new Error("failed to read EPIPE"))).toBe(false);
    expect(isBrokenConsolePipe("read EPIPE")).toBe(false);
    expect(isBrokenConsolePipe(undefined)).toBe(false);
  });
});

describe("guardConsolePipes", () => {
  const setUp = () => {
    const source = new EventEmitter();
    const lines: string[] = [];
    const exits: number[] = [];
    const remove = guardConsolePipes(
      (line) => lines.push(line),
      source,
      (code) => exits.push(code),
    );
    return { source, lines, exits, remove };
  };

  it("keeps the host serving after a console pipe breaks, and says so", () => {
    const { source, lines, exits } = setUp();
    source.emit("uncaughtException", errno("read EPIPE", "EPIPE", "read"));
    expect(exits).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("console pipe broke");
    expect(lines[0]).toContain("read EPIPE (EPIPE, read)");
  });

  it("still stops on any other uncaught exception, with the reason logged", () => {
    const { source, lines, exits } = setUp();
    source.emit("uncaughtException", new TypeError("boom"));
    expect(exits).toEqual([1]);
    expect(lines[0]).toContain("uncaught exception");
    expect(lines[0]).toContain("boom");
  });

  it("removes itself", () => {
    const { source, remove } = setUp();
    expect(source.listenerCount("uncaughtException")).toBe(1);
    remove();
    expect(source.listenerCount("uncaughtException")).toBe(0);
  });
});
