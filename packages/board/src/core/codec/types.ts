// 白板文档 v3 解码后的内存结构（docs/design/board-engine.md §3.2）。
// 线上格式用短键，这里是长名、可读的对象：调试与业务代码只看这一套。

import type { InkPoint } from "./ink-pack";

export const BOARD_ENGINE = "armadra-board";
export const BOARD_VERSION = 3;

/** 白板对象 id 在引用里的前缀（`references.itemId` = `wb:<id>`）。 */
export const ITEM_ID_PREFIX = "wb:";

export const ITEM_KINDS = ["ink", "text", "shape", "image", "line"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const COLORS = [
  "black",
  "grey",
  "white",
  "blue",
  "light-blue",
  "green",
  "light-green",
  "yellow",
  "orange",
  "red",
  "light-red",
  "violet",
  "light-violet",
] as const;
export type Color = (typeof COLORS)[number];

export const STROKE_SIZES = ["s", "m", "l", "xl"] as const;
export type StrokeSize = (typeof STROKE_SIZES)[number];

export const DASHES = ["solid", "dashed", "dotted"] as const;
export type Dash = (typeof DASHES)[number];

export const FILLS = ["none", "semi", "solid"] as const;
export type Fill = (typeof FILLS)[number];

export const ALIGNS = ["start", "middle", "end"] as const;
export type Align = (typeof ALIGNS)[number];

export const GEOS = [
  "rectangle",
  "ellipse",
  "diamond",
  "triangle",
  "hexagon",
  "star",
] as const;
export type Geo = (typeof GEOS)[number];

/** 缺省样式：编码时与它相同的值不写，解码时缺省值补回（`dash`、`fill` 缺省时不出现）。 */
export const DEFAULT_COLOR: Color = "black";
export const DEFAULT_SIZE: StrokeSize = "m";
export const DEFAULT_DASH: Dash = "solid";
export const DEFAULT_FILL: Fill = "none";

export interface ItemStyle {
  color: Color;
  size: StrokeSize;
  /** 缺省 `solid`，值为缺省时不出现。 */
  dash?: Dash;
  /** 缺省 `none`，值为缺省时不出现。 */
  fill?: Fill;
  align?: Align;
}

/** Agent 回复输出到画板时记下来自哪个节点；只用于显示与跳回。 */
export interface ItemMeta {
  source?: { nodeId: string; sessionId: string; messageId?: string };
}

interface ItemBase {
  /** 12 位 base62 随机串。 */
  id: string;
  kind: ItemKind;
  /** 画布单位的整数；有 `parentId` 时相对父。 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 升序即绘制顺序。 */
  z: number;
  parentId?: string;
  style: ItemStyle;
  meta?: ItemMeta;
}

export interface InkItem extends ItemBase {
  kind: "ink";
  highlight?: boolean;
  /** 相对对象原点，位于落成时的原始盒内；画出来时按 `w / origin.w`、`h / origin.h` 缩放。 */
  points: InkPoint[];
  /** 落成时的原始盒 `[w0, h0]`；缺省按当前 `w`、`h`（即未缩放过）。 */
  origin?: { w: number; h: number };
}

export interface TextItem extends ItemBase {
  kind: "text";
  text: string;
}

export interface ShapeItem extends ItemBase {
  kind: "shape";
  geo: Geo;
  label?: string;
}

export interface ImageItem extends ItemBase {
  kind: "image";
  /** 工作区相对路径（`.armadra/assets/…`）。 */
  assetPath: string;
  alt?: string;
}

export interface LineItem extends ItemBase {
  kind: "line";
  /** 折点 `[x, y]`，整数，相对对象原点，至少两个。 */
  points: [number, number][];
  arrowStart?: boolean;
  arrowEnd?: boolean;
}

export type Item = InkItem | TextItem | ShapeItem | ImageItem | LineItem;

/** 白板对象 → Agent 的内容引用；`id` 仍是 uuid（它是 `ContextLink.id` 与导出文件名）。 */
export interface Reference {
  id: string;
  itemId: string;
  nodeId: string;
}

export interface BoardDoc {
  engine: typeof BOARD_ENGINE;
  version: typeof BOARD_VERSION;
  items: Item[];
  references: Reference[];
}

export type DecodeResult<T> =
  { ok: true; value: T } | { ok: false; error: string };
