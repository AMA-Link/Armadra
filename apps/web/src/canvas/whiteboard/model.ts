import { codec } from "@armadra/board/core";

/**
 * 白板文档 v3（设计 docs/design/board-engine.md §3，归属 whiteboard）。
 *
 * `boards.whiteboard_json` 对 Runtime 与 Host 是不透明字节，格式由前端独占。
 * v3 的线上形状（短键、墨迹点集压缩、缺省值不写）与编解码在引擎包的 core 入口
 * （`packages/board/src/core/codec`），这里只做应用侧的再导出与 `wb:` 前缀辅助：
 * 内存里是长名、可读的对象（`Item`），序列化时才压成线上格式。
 *
 * **只认 v3**：`engine` / `version` 对不上的一律按空白板处理，下一次保存覆盖
 * （§3.5，不迁移、不读 v2）。
 */

export const WHITEBOARD_ENGINE = codec.BOARD_ENGINE;
export const WHITEBOARD_VERSION = codec.BOARD_VERSION;

/** 白板对象 id 在选区 / 引擎实体 id 里的前缀。`nodes` 行的 id 是裸 uuid，两者靠它区分。 */
export const ITEM_ID_PREFIX = codec.ITEM_ID_PREFIX;

export const ITEM_KINDS = codec.ITEM_KINDS;
export type ItemKind = codec.ItemKind;

/** 六种几何形（§1.2 F23）；旧引擎的另外 14 种不再支持。 */
export const GEOS = codec.GEOS;
export type Geo = codec.Geo;

export const DASHES = codec.DASHES;
export type Dash = codec.Dash;

export const FILLS = codec.FILLS;
export type Fill = codec.Fill;

export const ALIGNS = codec.ALIGNS;
export type Align = codec.Align;

export type ItemStyle = codec.ItemStyle;
export type InkItem = codec.InkItem;
export type TextItem = codec.TextItem;
export type ShapeItem = codec.ShapeItem;
export type ImageItem = codec.ImageItem;
export type LineItem = codec.LineItem;
export type Item = codec.Item;
export type Reference = codec.Reference;
export type WhiteboardDoc = codec.BoardDoc;

/** 墨迹的一个采样点：`[x, y, 压力]`，坐标相对对象原点。 */
export type InkPoint = codec.InkPoint;
/** 直线 / 箭头的折点：`[x, y]`，相对对象原点。 */
export type LinePoint = [number, number];

/** 单条墨迹的点数上限；落成时由 `simplifyPoints` 压到这以内。 */
export const MAX_INK_POINTS = codec.MAX_INK_POINTS;

export function emptyWhiteboard(): WhiteboardDoc {
  return codec.emptyDoc();
}

/** 空文档没有对象也没有引用；序列化前用它跳过一次编码。 */
export function isEmptyWhiteboard(doc: WhiteboardDoc): boolean {
  return doc.items.length === 0 && doc.references.length === 0;
}

/* -------------------------------- id 辅助 ---------------------------------- */

/** 白板对象 id：12 位 base62 随机串（约 71 bit）。 */
export function newItemId(): string {
  return codec.newItemId(
    (bytes) => void crypto.getRandomValues(bytes as Uint8Array<ArrayBuffer>),
  );
}

export function toItemId(id: string): string {
  return id.startsWith(ITEM_ID_PREFIX) ? id : `${ITEM_ID_PREFIX}${id}`;
}

export function fromItemId(id: string): string {
  return id.startsWith(ITEM_ID_PREFIX) ? id.slice(ITEM_ID_PREFIX.length) : id;
}

export function isItemId(id: string): boolean {
  return id.startsWith(ITEM_ID_PREFIX);
}
