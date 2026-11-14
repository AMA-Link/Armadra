/**
 * 工作空间的 git 远端（契约 §111.1）：`git remote -v` 与 gh-resolved 的读法、主
 * remote 的挑选顺序、地址里凭据的剥离。
 */

import { describe, expect, it } from "vitest";

import {
  chooseRemote,
  parseGhResolved,
  parseRemotes,
  stripCredentials,
} from "./remotes";

const VERBOSE = [
  "origin\tgit@github.com:me/app.git (fetch)",
  "origin\tgit@github.com:me/app.git (push)",
  "upstream\thttps://github.com/acme/app.git (fetch)",
  "upstream\tDISABLED (push)",
  "mirror\tssh://git@git.corp.test:2222/me/app (fetch)",
].join("\n");

describe("parseRemotes", () => {
  it("只取 fetch 地址，每个名字一条，按名字排序", () => {
    expect(parseRemotes(VERBOSE)).toEqual([
      { name: "mirror", url: "ssh://git@git.corp.test:2222/me/app" },
      { name: "origin", url: "git@github.com:me/app.git" },
      { name: "upstream", url: "https://github.com/acme/app.git" },
    ]);
  });

  it("空输出与不合格的名字", () => {
    expect(parseRemotes("")).toEqual([]);
    expect(parseRemotes("-bad\thttps://x/y/z (fetch)")).toEqual([]);
  });
});

describe("parseGhResolved", () => {
  it("名字里带点也认", () => {
    expect(
      parseGhResolved(
        "remote.upstream.gh-resolved base\nremote.a.b.gh-resolved owner/repo",
      ),
    ).toEqual(["upstream", "a.b"]);
    expect(parseGhResolved("")).toEqual([]);
  });
});

describe("chooseRemote", () => {
  const remotes = (...names: string[]) =>
    names.map((name) => ({ name, url: `https://h.test/o/${name}` }));

  it("用户选择 → gh-resolved → upstream → origin → 名字排序首个", () => {
    const all = remotes("origin", "upstream", "zeta", "fork");
    expect(chooseRemote(all, { user: "fork", ghResolved: ["zeta"] })).toEqual({
      name: "fork",
      by: "user",
    });
    expect(chooseRemote(all, { ghResolved: ["zeta"] })).toEqual({
      name: "zeta",
      by: "ghResolved",
    });
    expect(chooseRemote(all, {})).toEqual({ name: "upstream", by: "upstream" });
    expect(chooseRemote(remotes("origin", "fork"), {})).toEqual({
      name: "origin",
      by: "origin",
    });
    expect(chooseRemote(remotes("zeta", "fork"), {})).toEqual({
      name: "fork",
      by: "first",
    });
    expect(chooseRemote([], {})).toBeNull();
  });

  it("用户选的名字已经不存在时当作没选；gh-resolved 指向不存在的 remote 也忽略", () => {
    const all = remotes("origin", "upstream");
    expect(chooseRemote(all, { user: "gone", ghResolved: ["gone"] })).toEqual({
      name: "upstream",
      by: "upstream",
    });
  });
});

describe("stripCredentials", () => {
  it("http(s) 去掉整段 userinfo，其余协议只去密码", () => {
    expect(stripCredentials("https://user:s3cret@github.com/a/b.git")).toBe(
      "https://github.com/a/b.git",
    );
    expect(stripCredentials("https://ghp_token@github.com/a/b")).toBe(
      "https://github.com/a/b",
    );
    expect(stripCredentials("https://u:p@ss@h.test/a/b")).toBe(
      "https://h.test/a/b",
    );
    expect(stripCredentials("ssh://git:pw@h.test:22/a/b")).toBe(
      "ssh://git@h.test:22/a/b",
    );
  });

  it("scp 写法与无凭据地址原样", () => {
    expect(stripCredentials("git@github.com:a/b.git")).toBe(
      "git@github.com:a/b.git",
    );
    expect(stripCredentials("https://github.com/a/b")).toBe(
      "https://github.com/a/b",
    );
  });
});
