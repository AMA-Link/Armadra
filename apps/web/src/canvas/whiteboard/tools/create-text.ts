import type { Position } from "@armadra/shared";

import { addItems, createItemId, select } from "../store";
import { textItemAt } from "./draft";

/**
 * 在 `at`（画布坐标）新建一条空文字并选中它，返回它的 id。
 *
 * 选中 + 空文本 = `TextNode` 的 `autoEdit`，光标直接落在里面；用户空着提交
 * （失焦 / Esc）时 `InlineText` 会把它连同撤销记录一起丢弃（`store.discardItem`），
 * 所以这条函数可以放心地「先建后填」，不会在画布上留下空对象。
 *
 * 双击空白、文字工具点一下、手机上的轻点 / 长按创建都走这一个入口：
 * 落点的换算（屏幕 → 画布、吸附）留给调用方，这里只管文档。
 */
export function createTextAt(at: Position): string {
  const item = textItemAt(at, createItemId());
  addItems([item]);
  select([item.id]);
  return item.id;
}
