import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const INSTALL = fileURLToPath(new URL("./install.mjs", import.meta.url));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "armadra-install-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** 测试自己起的 git 也不能带上调用方（例如钩子）的 GIT_*。 */
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
);
const git = (cwd, args, extra = {}) =>
  spawnSync("git", args, { cwd, encoding: "utf8", env: { ...env, ...extra } });

/** 一个带 .githooks/pre-push 与 tools/hooks/install.mjs 的临时仓库。 */
function repo(name, { hooks = true } = {}) {
  const dir = join(scratch, name);
  mkdirSync(join(dir, "tools/hooks"), { recursive: true });
  assert.equal(git(dir, ["init", "-q"]).status, 0);
  copyFileSync(INSTALL, join(dir, "tools/hooks/install.mjs"));
  if (hooks) {
    mkdirSync(join(dir, ".githooks"));
    writeFileSync(join(dir, ".githooks/pre-push"), "#!/bin/sh\n");
  }
  return dir;
}

const hooksPath = (dir) =>
  git(dir, ["config", "--local", "--get", "core.hooksPath"]).stdout.trim();
const install = (dir, extra = {}) =>
  spawnSync(process.execPath, [join(dir, "tools/hooks/install.mjs")], {
    cwd: dir,
    encoding: "utf8",
    env: { ...env, ...extra },
  });

test("设到自己仓库；GIT_DIR 指向别的仓库时也不写进那个仓库", () => {
  const caller = repo("caller", { hooks: false });
  const target = repo("target");
  const result = install(target, {
    GIT_DIR: join(caller, ".git"),
    GIT_WORK_TREE: caller,
    GIT_INDEX_FILE: join(caller, ".git/index"),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(hooksPath(target), ".githooks");
  assert.equal(hooksPath(caller), "");
});

test("已经设成别的值不改；没有 .githooks 什么都不做", () => {
  const custom = repo("custom");
  git(custom, ["config", "--local", "core.hooksPath", "my-hooks"]);
  assert.equal(install(custom).status, 0);
  assert.equal(hooksPath(custom), "my-hooks");
  const bare = repo("no-hooks", { hooks: false });
  assert.equal(install(bare).status, 0);
  assert.equal(hooksPath(bare), "");
});
