import { statSync } from "node:fs";
import { join } from "node:path";

/**
 * 新建工作空间对话框要的克隆缺省父目录（契约 §65.1）。仓库列表走代码托管的
 * `forge.repositories`（§29.7），不在这里。
 */

/** 家目录下按这个顺序找第一个存在的目录，都没有就用家目录本身。 */
const PARENT_CANDIDATES = ["Projects", "projects", "Developer", "code", "src"];

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 克隆的缺省父目录：`~/Projects` 这类常见目录，没有就是 `~`。 */
export function defaultCloneParent(home: string | undefined): {
  parent: string;
} {
  if (home === undefined) return { parent: "" };
  for (const name of PARENT_CANDIDATES) {
    const candidate = join(home, name);
    if (isDirectory(candidate)) return { parent: candidate };
  }
  return { parent: home };
}
