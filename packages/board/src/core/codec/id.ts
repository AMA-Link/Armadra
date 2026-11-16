// 白板对象 id：12 位 base62 随机串（约 71 bit）。随机源由调用方注入，core 不碰 crypto 全局。

import { ITEM_ID_PREFIX } from "./types";

const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export const ITEM_ID_LENGTH = 12;

/** 把随机字节填进传入的数组，例如 `(b) => crypto.getRandomValues(b)`。 */
export type FillRandom = (bytes: Uint8Array) => void;

/** 拒绝采样（字节 ≥ 248 丢弃），base62 各字符等概率。 */
export function newItemId(fill: FillRandom): string {
  let id = "";
  const buf = new Uint8Array(ITEM_ID_LENGTH * 2);
  while (id.length < ITEM_ID_LENGTH) {
    fill(buf);
    for (let i = 0; i < buf.length && id.length < ITEM_ID_LENGTH; i++) {
      const b = buf[i]!;
      if (b < 248) id += ALPHABET[b % 62];
    }
  }
  return id;
}

export function isItemId(id: string): boolean {
  return id.length === ITEM_ID_LENGTH && /^[0-9A-Za-z]+$/.test(id);
}

/** `references.itemId` 用 `wb:<id>`。 */
export function toRefItemId(id: string): string {
  return id.startsWith(ITEM_ID_PREFIX) ? id : `${ITEM_ID_PREFIX}${id}`;
}

export function fromRefItemId(itemId: string): string {
  return itemId.startsWith(ITEM_ID_PREFIX)
    ? itemId.slice(ITEM_ID_PREFIX.length)
    : itemId;
}
