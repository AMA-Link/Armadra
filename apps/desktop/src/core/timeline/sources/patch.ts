/**
 * Codex 的 `apply_patch` 补丁文本 → 逐文件的 diff（设计 §5.2）。
 *
 * 格式：
 *
 *     *** Begin Patch
 *     *** Add File: a.txt          （后面每行以 `+` 开头）
 *     *** Update File: b.txt       （可跟 `*** Move to: c.txt`，再是若干 `@@` 块，
 *                                    块内每行以 ` ` / `-` / `+` 开头）
 *     *** Delete File: d.txt
 *     *** End Patch
 *
 * 只解析我们要显示的东西；认不出的行跳过，不抛错。
 */

import { sidesOfLines } from "./convert-util";

export interface PatchFile {
  readonly op: "add" | "update" | "delete";
  readonly path: string;
  readonly movedTo?: string;
  /** 新增文件为 `null`；删除的文件没有正文（补丁里不带）。 */
  readonly oldText: string | null;
  readonly newText: string;
}

export function parseApplyPatch(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  let current:
    | {
        op: "add" | "update" | "delete";
        path: string;
        moved?: string;
        lines: string[];
      }
    | undefined;
  const flush = () => {
    if (current === undefined) return;
    if (current.op === "add") {
      files.push({
        op: "add",
        path: current.path,
        oldText: null,
        newText: current.lines.map((l) => l.slice(1)).join("\n"),
      });
    } else if (current.op === "delete") {
      files.push({
        op: "delete",
        path: current.path,
        oldText: "",
        newText: "",
      });
    } else {
      const sides = sidesOfLines(current.lines);
      files.push({
        op: "update",
        path: current.path,
        ...(current.moved !== undefined ? { movedTo: current.moved } : {}),
        oldText: sides.oldText,
        newText: sides.newText,
      });
    }
    current = undefined;
  };
  for (const line of patch.split("\n")) {
    const add = /^\*\*\* Add File: (.+)$/.exec(line);
    const update = /^\*\*\* Update File: (.+)$/.exec(line);
    const del = /^\*\*\* Delete File: (.+)$/.exec(line);
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (add !== null || update !== null || del !== null) {
      flush();
      if (add !== null)
        current = { op: "add", path: (add[1] as string).trim(), lines: [] };
      else if (update !== null)
        current = {
          op: "update",
          path: (update[1] as string).trim(),
          lines: [],
        };
      else
        current = {
          op: "delete",
          path: (del?.[1] as string).trim(),
          lines: [],
        };
      continue;
    }
    if (current === undefined) continue;
    if (move !== null) {
      current.moved = (move[1] as string).trim();
      continue;
    }
    if (line.startsWith("*** ")) {
      // `*** End Patch` / `*** End of File`
      if (line.startsWith("*** End Patch")) flush();
      continue;
    }
    if (line.startsWith("@@")) {
      // 块之间留一行分隔，免得两段不相邻的改动被读成一段。
      if (current.op === "update" && current.lines.length > 0) {
        current.lines.push(" ");
      }
      continue;
    }
    if (current.op === "add") {
      if (line.startsWith("+")) current.lines.push(line);
    } else if (current.op === "update") {
      if (line === "") continue;
      if (/^[ +-]/.test(line)) current.lines.push(line);
    }
  }
  flush();
  return files;
}
