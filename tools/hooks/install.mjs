/**
 * 把 git 钩子目录指到仓库里的 `.githooks`（#953）。`pnpm install` 的 `prepare` 调用；
 * 不在本仓库的 git 检出里（打包、镜像构建、作为依赖安装）就什么都不做。
 * 已经指到别处的（个人的钩子目录）不改，只提示一句。
 */
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HOOKS = ".githooks";

function git(args) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

const top = git(["rev-parse", "--show-toplevel"]);
if (
  top !== null &&
  existsSync(join(ROOT, HOOKS, "pre-push")) &&
  realpathSync(top) === realpathSync(ROOT)
) {
  const current = git(["config", "--get", "core.hooksPath"]);
  if (current === null) git(["config", "core.hooksPath", HOOKS]);
  else if (current !== HOOKS)
    console.log(
      `core.hooksPath 已是 ${current}，没有改成 ${HOOKS}；要用仓库的推送前检查就 git config core.hooksPath ${HOOKS}`,
    );
}
