import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findProblems, hasListColon } from "./portability-check.mjs";

const lines = (text) => findProblems(text, "x.test.ts").map((p) => p.line);

describe("PATH 用 `:` 写死", () => {
  it("抓到 #950 的写法：对象里的字面量", () => {
    assert.deepEqual(lines(`minimalEnv({}, { PATH: "/usr/bin:/bin" });`), [1]);
  });

  it("抓到模板、join、赋值、元组与 split", () => {
    const text = [
      "const a = { PATH: `${bin}:${process.env.PATH}` };",
      'const b = { PATH: [x, y].join(":") };',
      "process.env.PATH = `${bin}:${before}`;",
      'const c = [["PATH", "/a:/b"]];',
      'expect(env.PATH?.split(":")).toContain(bin);',
      'env["PATH"] = "/a:" + rest;',
    ].join("\n");
    assert.deepEqual(lines(text), [1, 2, 3, 4, 5, 6]);
  });

  it("按 path.delimiter 拼的、盘符、URL、别的变量都不算", () => {
    const text = [
      "const a = { PATH: [x, y].join(delimiter) };",
      "const b = { PATH: `${bin}${delimiter}${process.env.PATH}` };",
      'const c = { PATH: "C:\\\\Windows\\\\System32" };',
      'const d = { PATH: "C:/tools" };',
      'const e = { HOME: "/a:/b", URL: "http://x:1" };',
      'const f = { PATH: [x, y].join(win ? ";" : ":") };',
      'const g = "PATH=/usr/bin:/bin";',
      'const h = line.split(":");',
      'findExecutable("bwrap", { PATH: "/a:/b" }, check, "linux");',
      'probe({ platform: "darwin", env: { PATH: "/a:/b" } });',
    ].join("\n");
    assert.deepEqual(lines(text), []);
  });

  it("Windows 上不跑的代码放行", () => {
    const text = [
      'describe.skipIf(process.platform === "win32")("x", () => {',
      '  it("a", () => run({ PATH: "/a:/b" }));',
      "});",
      'const unix = process.platform !== "win32";',
      "const describeUnix = unix ? describe : describe.skip;",
      'describeUnix("y", () => { run({ PATH: "/a:/b" }); });',
      'it.runIf(unix)("z", () => run({ PATH: "/a:/b" }));',
      "function f() {",
      '  if (process.platform === "win32") return;',
      '  run({ PATH: "/a:/b" });',
      "}",
      'const p = isWindows ? "C:\\\\x" : { PATH: "/a:/b" };',
    ].join("\n");
    assert.deepEqual(lines(text), []);
  });

  it("portability-ok 注释放行同一行与下一行", () => {
    const text = [
      "// portability-ok: 发给远端 Linux",
      'run({ PATH: "/a:/b" });',
      'run({ PATH: "/a:/b" }); // portability-ok: 同上',
      "",
      'run({ PATH: "/a:/b" });',
    ].join("\n");
    assert.deepEqual(lines(text), [5]);
  });

  it("hasListColon 不把盘符和 :// 当分隔符", () => {
    assert.equal(hasListColon("/usr/bin:/bin"), true);
    assert.equal(hasListColon("C:\\x"), false);
    assert.equal(hasListColon("https://x"), false);
  });
});
