/**
 * SSH 别名（契约 §111.1）：`ssh -G` 取真实主机；超时、没配、没有 ssh 都用原值；
 * 外部命令全部是 mock，不起真的 ssh。
 */

import { describe, expect, it } from "vitest";

import type { CommandRunner } from "./exec";
import { SshAliasResolver } from "./ssh-alias";

function runner(table: Record<string, string>): {
  run: CommandRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const run: CommandRunner = async (file, args) => {
    calls.push([file, ...args]);
    const alias = args[args.length - 1] as string;
    if (alias in table) {
      return {
        ok: true,
        stdout: `user git\nhostname ${table[alias]}\nport 22\n`,
      };
    }
    return { ok: false, stdout: "" };
  };
  return { run, calls };
}

describe("SshAliasResolver", () => {
  it("scp 写法：别名换成真实主机，用户与路径不变", async () => {
    const { run, calls } = runner({ "github-work": "github.com" });
    const resolver = new SshAliasResolver({ run });
    expect(await resolver.resolve("git@github-work:org/repo.git")).toBe(
      "git@github.com:org/repo.git",
    );
    expect(calls).toEqual([["ssh", "-G", "github-work"]]);
  });

  it("ssh:// 写法", async () => {
    const { run } = runner({ corp: "git.corp.test" });
    const resolver = new SshAliasResolver({ run });
    const out = await resolver.resolve("ssh://git@corp/team/app.git");
    expect(out).toContain("git.corp.test");
    expect(out).toContain("/team/app.git");
  });

  it("按别名缓存：第二次不再起 ssh", async () => {
    const { run, calls } = runner({ alias: "real.test" });
    let at = 0;
    const resolver = new SshAliasResolver({ run, now: () => at });
    await resolver.resolve("git@alias:a/b");
    at += 1_000;
    await resolver.resolve("git@alias:c/d");
    expect(calls).toHaveLength(1);
    at += 10 * 60_000;
    await resolver.resolve("git@alias:c/d");
    expect(calls).toHaveLength(2);
  });

  it("问不到、别名就是主机本身、https 与已知主机都原样", async () => {
    const { run, calls } = runner({ same: "same", boom: "x y" });
    const resolver = new SshAliasResolver({ run });
    expect(await resolver.resolve("git@unknown:a/b")).toBe("git@unknown:a/b");
    expect(await resolver.resolve("git@same:a/b")).toBe("git@same:a/b");
    // 主机名里带空白的输出不是合格主机
    expect(await resolver.resolve("git@boom:a/b")).toBe("git@boom:a/b");
    expect(await resolver.resolve("https://corp/a/b")).toBe("https://corp/a/b");
    const before = calls.length;
    expect(await resolver.resolve("git@github.com:a/b")).toBe(
      "git@github.com:a/b",
    );
    expect(calls).toHaveLength(before);
  });

  it("命令抛错也不外传", async () => {
    const resolver = new SshAliasResolver({
      run: async () => {
        throw new Error("spawn ssh ENOENT");
      },
    });
    expect(await resolver.resolve("git@alias:a/b")).toBe("git@alias:a/b");
  });

  it("以连字符开头的别名不交给 ssh", async () => {
    const { run, calls } = runner({});
    const resolver = new SshAliasResolver({ run });
    expect(
      await resolver.resolve("-oProxyCommand=x@-oProxyCommand=x:a/b"),
    ).toBe("-oProxyCommand=x@-oProxyCommand=x:a/b");
    expect(calls).toEqual([]);
  });
});
