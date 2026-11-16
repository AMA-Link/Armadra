/**
 * 把 git 钩子目录指到仓库里的 `.githooks`（#953）。`pnpm install` 的 `prepare` 调用；
 * 不在本仓库的 git 检出里（打包、镜像构建、作为依赖安装）就什么都不做。
 * 已经指到别处的（个人的钩子目录）不改，只提示一句。
 *
 * git 子进程一律去掉 GIT_* 环境、写入用 `--local`：从别的仓库的钩子里被调起时
 * （GIT_DIR 指向那个仓库），不能把设置写进那个仓库。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HOOKS = ".githooks";

function git(args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", env });
  return result.status === 0 ? result.stdout.trim() : null;
}

// 前缀为空才是检出根目录；不比路径，Windows 上 git 给长路径、临时目录可能是 8.3 短名。
const prefix = git(["rev-parse", "--show-prefix"]);
if (prefix === "" && existsSync(join(ROOT, HOOKS, "pre-push"))) {
  const current = git(["config", "--local", "--get", "core.hooksPath"]);
  if (current === null) git(["config", "--local", "core.hooksPath", HOOKS]);
  else if (current !== HOOKS)
    console.log(
      `core.hooksPath 已是 ${current}，没有改成 ${HOOKS}；要用仓库的推送前检查就 git config --local core.hooksPath ${HOOKS}`,
    );
}
