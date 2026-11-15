/** 外部命令的最小环境：PATH 补上 Homebrew 等目录（从 Dock 启动时也找得到 gh）。 */

import { mkdtempSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { minimalEnv } from "./exec";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("minimalEnv", () => {
  it("launchd 的 PATH 之后追加用户目录下的 CLI 目录，原有的仍在前面", () => {
    const home = mkdtempSync(join(tmpdir(), "armadra-forge-exec-"));
    made.push(home);
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    const env = minimalEnv(
      { EXTRA: "1" },
      { PATH: "/usr/bin:/bin", HOME: home, SECRET: "x" },
    );
    const path = (env.PATH ?? "").split(delimiter);
    expect(path.slice(0, 2)).toEqual(["/usr/bin", "/bin"]);
    expect(path).toContain(join(home, ".local", "bin"));
    expect(env.EXTRA).toBe("1");
    expect(env.HOME).toBe(home);
    // 不继承最小集合以外的变量。
    expect(env.SECRET).toBeUndefined();
  });

  it("补 Homebrew 的目录（机器上有时）", () => {
    const env = minimalEnv({}, { PATH: "/usr/bin:/bin" });
    const path = (env.PATH ?? "").split(delimiter);
    for (const dir of ["/opt/homebrew/bin", "/usr/local/bin"]) {
      let exists: boolean;
      try {
        exists = statSync(dir).isDirectory();
      } catch {
        exists = false;
      }
      expect(path.includes(dir)).toBe(exists);
    }
  });
});
