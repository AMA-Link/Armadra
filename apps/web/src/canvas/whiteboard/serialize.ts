import { codec } from "@armadra/board/core";

import { emptyWhiteboard, type WhiteboardDoc } from "./model";

/**
 * `boards.whiteboard_json` 的读写（设计 §3，归属 whiteboard）。
 *
 * **只认 v3。** 用户决定不迁移旧快照，也不备份（§3.5）：空串、解析失败、
 * `engine` / `version` 对不上、任何一条对象校验不过——一律按 `emptyWhiteboard()`
 * 处理，下一次保存直接覆盖。不弹提示、不留原文、不生成转换报告。
 *
 * 全是纯函数：没有 DOM、没有 store，序列化的输入就是那份文档。
 */

export function serializeWhiteboard(doc: WhiteboardDoc): string {
  return codec.encodeDoc(doc);
}

/**
 * 解析一份存量文本。识别不了的一律给空文档。
 *
 * `recognised` 是给调用方看的：`false` 表示这份文本被丢弃了（上一代
 * 快照、损坏的 JSON、或者更高版本写出来的东西），下一次保存会覆盖它。
 */
export interface ParsedWhiteboard {
  doc: WhiteboardDoc;
  recognised: boolean;
}

export function parseWhiteboard(
  text: string | null | undefined,
): ParsedWhiteboard {
  if (!text) return { doc: emptyWhiteboard(), recognised: false };
  const decoded = codec.decodeDoc(text);
  if (!decoded.ok) return { doc: emptyWhiteboard(), recognised: false };
  return { doc: decoded.value, recognised: true };
}
