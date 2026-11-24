import type { ForgeCheckState, ForgeFileStatus } from "./types";

/** Gitea 线上字段到领域值的纯转换。 */

export function fileStatus(value: string | undefined): ForgeFileStatus {
  switch (value) {
    case "added":
      return "added";
    case "deleted":
      return "removed";
    case "renamed":
      return "renamed";
    case "changed":
    case "modified":
      return "modified";
    default:
      return "other";
  }
}

export function checkState(value: string | undefined): ForgeCheckState {
  switch (value) {
    case "success":
      return "success";
    case "failure":
    case "error":
      return "failure";
    case "warning":
      return "neutral";
    default:
      return "pending";
  }
}

/**
 * 把一份统一差异按文件切开，键是新路径（删除的文件是旧路径）。补丁从第一个
 * `@@` 开始，与 GitHub 的 `patch` 字段同一个起点；二进制文件没有 `@@`，不在表里。
 */
export function splitDiff(diff: string): Map<string, string> {
  const patches = new Map<string, string>();
  const blocks = diff.split(/^(?=diff --git )/m);
  for (const block of blocks) {
    if (!block.startsWith("diff --git ")) continue;
    const lines = block.split("\n");
    let path = "";
    for (const line of lines) {
      if (line.startsWith("@@")) break;
      if (line.startsWith("+++ b/")) path = line.slice(6);
      else if (line.startsWith("rename to ")) path = path || line.slice(10);
      else if (line.startsWith("--- a/") && path === "") path = line.slice(6);
    }
    if (path === "") {
      // 没有 `---` / `+++` 的块（纯改名、二进制）：头里 a/ 与 b/ 等长时取 b/。
      const header = (lines[0] ?? "").slice("diff --git ".length);
      const half = (header.length - 1) / 2;
      if (Number.isInteger(half) && header.startsWith("a/")) {
        path = header.slice(half + 1).replace(/^b\//, "");
      }
    }
    const hunk = block.indexOf("\n@@");
    if (path === "" || hunk < 0) continue;
    patches.set(path, block.slice(hunk + 1).replace(/\n$/, ""));
  }
  return patches;
}
