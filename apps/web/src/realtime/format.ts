import type * as Y from "yjs";

import { edgesOf, itemsOf, metaOf, nodesOf } from "./doc";

/**
 * 实时板的格式闸（设计 §3.5 / R4）：新旧客户端不同格式时拒绝加入。
 *
 * 一块实时板的 `Y.Doc` 只有一种格式：旧客户端认不出新对象、新客户端认不出旧对象，
 * 外壳 `version` 还会互相覆盖。握手本身不带版本，所以格式号写在文档里：
 * `meta.boardFormat`。第一个以写者身份同步完成的客户端落下自己的格式号，之后
 * 同步完成的客户端都拿自己的号去比，不一样就退出实时、提示升级，不往里写任何东西。
 *
 * 没有这个键的文档来自没有闸的旧客户端，它们全是 {@link LEGACY_FORMAT}。
 * 写白板线格式 v3（Armadra#952 B5）的客户端是 3。
 */
export const BOARD_FORMAT = 3;
export const LEGACY_FORMAT = 2;
export const FORMAT_KEY = "boardFormat";

/** 落下格式号的事务来源：不在撤销栈追踪的来源之内，撤销不会把它撤掉。 */
export const FORMAT_ORIGIN = "board-format";

export type FormatVerdict = "ok" | "stamp" | "mismatch";

/** 文档里记着的格式号；没记过是 {@link LEGACY_FORMAT}，记坏了当不匹配。 */
export function remoteFormat(doc: Y.Doc): number | null {
  const value = metaOf(doc).get(FORMAT_KEY);
  if (value === undefined) return LEGACY_FORMAT;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

const isEmpty = (doc: Y.Doc): boolean =>
  nodesOf(doc).size === 0 && edgesOf(doc).size === 0 && itemsOf(doc).size === 0;

/**
 * 同步完成时的判定：
 *
 *  - 记着格式号：一致放行（`ok`），不一致拒绝（`mismatch`）；
 *  - 没记过：空文档是刚建的板，谁先来谁落下自己的号（`stamp`）；非空的来自没有闸的
 *    旧客户端，按 {@link LEGACY_FORMAT} 比，一致就补一笔（`stamp`），不一致拒绝。
 */
export function checkFormat(
  doc: Y.Doc,
  own: number = BOARD_FORMAT,
): FormatVerdict {
  if (metaOf(doc).has(FORMAT_KEY)) {
    return remoteFormat(doc) === own ? "ok" : "mismatch";
  }
  if (isEmpty(doc)) return "stamp";
  return LEGACY_FORMAT === own ? "stamp" : "mismatch";
}

/** 以写者身份落下自己的格式号。 */
export function stampFormat(doc: Y.Doc, own: number = BOARD_FORMAT): void {
  doc.transact(() => metaOf(doc).set(FORMAT_KEY, own), FORMAT_ORIGIN);
}
