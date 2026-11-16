import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { guardStdio } from "./stdio-guard";

function pipeError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`write ${code}`), { code, syscall: "write" });
}

describe("guardStdio", () => {
  it("断开的管道只丢弃，不抛", () => {
    const stream = new EventEmitter();
    guardStdio([stream]);
    expect(() => stream.emit("error", pipeError("EPIPE"))).not.toThrow();
    expect(() => stream.emit("error", pipeError("ECONNRESET"))).not.toThrow();
  });

  it("其它错误照旧抛出", () => {
    const stream = new EventEmitter();
    guardStdio([stream]);
    expect(() => stream.emit("error", new Error("boom"))).toThrow("boom");
  });
});
