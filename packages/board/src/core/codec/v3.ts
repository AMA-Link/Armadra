// `whiteboard_json` v3 的编解码（docs/design/board-engine.md §3.2）。
//
// 线上是短键 JSON：公共头 id / k / b / z，可选 p / s / m，各类专有键见 `itemToWire`。
// 缺省样式不写，`b` 与 `ln` 取整；墨迹点集走 `ink-pack`。外壳 `engine` + `version`
// 之外一律解码失败（不迁移旧数据，由调用方当空白板）。校验手写，core 不带 zod。
// 所有解码函数不抛：失败返回 `{ ok: false, error }`。

import { MAX_INK_POINTS, packInk, unpackInk } from "./ink-pack";
import {
  ALIGNS,
  BOARD_ENGINE,
  BOARD_VERSION,
  COLORS,
  DASHES,
  DEFAULT_COLOR,
  DEFAULT_DASH,
  DEFAULT_FILL,
  DEFAULT_SIZE,
  FILLS,
  GEOS,
  ITEM_KINDS,
  STROKE_SIZES,
  type BoardDoc,
  type DecodeResult,
  type Item,
  type ItemMeta,
  type ItemStyle,
  type Reference,
} from "./types";

type Wire = Record<string, unknown>;

const fail = (error: string): { ok: false; error: string } => ({
  ok: false,
  error,
});
const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });

export function emptyDoc(): BoardDoc {
  return {
    engine: BOARD_ENGINE,
    version: BOARD_VERSION,
    items: [],
    references: [],
  };
}

/* --------------------------------- 编码 ----------------------------------- */

const int = (n: number): number => (Number.isFinite(n) ? Math.round(n) : 0);

function styleToWire(style: ItemStyle): Wire | undefined {
  const s: Wire = {};
  if (style.color !== DEFAULT_COLOR) s.c = style.color;
  if (style.size !== DEFAULT_SIZE) s.sz = style.size;
  if (style.dash && style.dash !== DEFAULT_DASH) s.d = style.dash;
  if (style.fill && style.fill !== DEFAULT_FILL) s.f = style.fill;
  if (style.align) s.a = style.align;
  return Object.keys(s).length > 0 ? s : undefined;
}

function metaToWire(meta: ItemMeta | undefined): Wire | undefined {
  const src = meta?.source;
  if (!src) return undefined;
  const source: Wire = { nodeId: src.nodeId, sessionId: src.sessionId };
  if (src.messageId !== undefined) source.messageId = src.messageId;
  return { source };
}

/** 一个对象 → 线上对象（键顺序固定，输出稳定）。 */
export function itemToWire(item: Item): Wire {
  const wire: Wire = {
    id: item.id,
    k: item.kind,
    b: [
      int(item.x),
      int(item.y),
      Math.max(0, int(item.w)),
      Math.max(0, int(item.h)),
    ],
    z: item.z,
  };
  if (item.parentId) wire.p = item.parentId;
  const s = styleToWire(item.style);
  if (s) wire.s = s;
  const m = metaToWire(item.meta);
  if (m) wire.m = m;
  switch (item.kind) {
    case "ink":
      if (item.highlight) wire.hl = 1;
      if (item.origin) wire.o = [int(item.origin.w), int(item.origin.h)];
      wire.pt = packInk(item.points);
      break;
    case "text":
      wire.t = item.text;
      break;
    case "shape":
      wire.g = item.geo;
      if (item.label !== undefined) wire.l = item.label;
      break;
    case "image":
      wire.a = item.assetPath;
      if (item.alt !== undefined) wire.al = item.alt;
      break;
    case "line":
      wire.ln = item.points.flatMap(([x, y]) => [int(x), int(y)]);
      if (item.arrowStart) wire.as = 1;
      if (item.arrowEnd) wire.ae = 1;
      break;
  }
  return wire;
}

/** 单条对象 → JSON 串（Y.Map 每项一条）。 */
export function encodeItem(item: Item): string {
  return JSON.stringify(itemToWire(item));
}

export function encodeDoc(doc: BoardDoc): string {
  return JSON.stringify({
    engine: BOARD_ENGINE,
    version: BOARD_VERSION,
    items: doc.items.map(itemToWire),
    references: doc.references.map((r) => ({
      id: r.id,
      itemId: r.itemId,
      nodeId: r.nodeId,
    })),
  });
}

/* --------------------------------- 解码 ----------------------------------- */

const isObj = (v: unknown): v is Wire =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNonEmpty = (v: unknown): v is string =>
  typeof v === "string" && v !== "";

function oneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

function styleFromWire(v: unknown): DecodeResult<ItemStyle> {
  const s = v === undefined ? {} : v;
  if (!isObj(s)) return fail("样式 s 不是对象");
  const color = s.c ?? DEFAULT_COLOR;
  const size = s.sz ?? DEFAULT_SIZE;
  if (!oneOf(COLORS, color)) return fail("样式颜色非法");
  if (!oneOf(STROKE_SIZES, size)) return fail("样式粗细非法");
  const style: ItemStyle = { color, size };
  if (s.d !== undefined) {
    if (!oneOf(DASHES, s.d)) return fail("样式线型非法");
    style.dash = s.d;
  }
  if (s.f !== undefined) {
    if (!oneOf(FILLS, s.f)) return fail("样式填充非法");
    style.fill = s.f;
  }
  if (s.a !== undefined) {
    if (!oneOf(ALIGNS, s.a)) return fail("样式对齐非法");
    style.align = s.a;
  }
  return ok(style);
}

function metaFromWire(v: unknown): DecodeResult<ItemMeta | undefined> {
  if (v === undefined) return ok(undefined);
  if (!isObj(v)) return fail("meta m 不是对象");
  const src = v.source;
  if (src === undefined) return ok({});
  if (!isObj(src) || !isStr(src.nodeId) || !isStr(src.sessionId)) {
    return fail("meta.source 非法");
  }
  if (src.messageId !== undefined && !isStr(src.messageId)) {
    return fail("meta.source.messageId 非法");
  }
  const source: NonNullable<ItemMeta["source"]> = {
    nodeId: src.nodeId,
    sessionId: src.sessionId,
  };
  if (src.messageId !== undefined) source.messageId = src.messageId;
  return ok({ source });
}

/** 线上对象 → 内存对象。 */
export function itemFromWire(v: unknown): DecodeResult<Item> {
  if (!isObj(v)) return fail("对象不是 JSON 对象");
  if (!isNonEmpty(v.id)) return fail("对象缺少 id");
  const { id } = v;
  const at = (msg: string) => fail(`对象 ${id}：${msg}`);
  if (!oneOf(ITEM_KINDS, v.k)) return at("种类 k 非法");
  const b = v.b;
  if (!Array.isArray(b) || b.length !== 4 || !b.every(isNum)) {
    return at("包围盒 b 非法");
  }
  const [x, y, w, h] = b as [number, number, number, number];
  if (w < 0 || h < 0) return at("包围盒宽高为负");
  if (!isNum(v.z)) return at("层序 z 非法");
  if (v.p !== undefined && !isNonEmpty(v.p)) return at("父 p 非法");
  const style = styleFromWire(v.s);
  if (!style.ok) return at(style.error);
  const meta = metaFromWire(v.m);
  if (!meta.ok) return at(meta.error);

  const head = { id, x, y, w, h, z: v.z, style: style.value };
  const common: { parentId?: string; meta?: ItemMeta } = {};
  if (v.p !== undefined) common.parentId = v.p as string;
  if (meta.value) common.meta = meta.value;
  const base = { ...head, ...common };

  switch (v.k) {
    case "ink": {
      if (!isStr(v.pt)) return at("点集 pt 非法");
      const pts = unpackInk(v.pt);
      if (!pts.ok) return at(pts.error);
      const item: Item = { ...base, kind: "ink", points: pts.value };
      if (v.hl !== undefined) {
        if (v.hl !== 1) return at("hl 非法");
        item.highlight = true;
      }
      if (v.o !== undefined) {
        const o = v.o;
        if (
          !Array.isArray(o) ||
          o.length !== 2 ||
          !o.every(isNum) ||
          o.some((n: number) => n < 0)
        ) {
          return at("原始盒 o 非法");
        }
        item.origin = { w: o[0] as number, h: o[1] as number };
      }
      return ok(item);
    }
    case "text":
      if (!isStr(v.t)) return at("文字 t 非法");
      return ok({ ...base, kind: "text", text: v.t });
    case "shape": {
      if (!oneOf(GEOS, v.g)) return at("几何形 g 非法");
      const item: Item = { ...base, kind: "shape", geo: v.g };
      if (v.l !== undefined) {
        if (!isStr(v.l)) return at("标签 l 非法");
        item.label = v.l;
      }
      return ok(item);
    }
    case "image": {
      if (!isNonEmpty(v.a)) return at("资源路径 a 非法");
      const item: Item = { ...base, kind: "image", assetPath: v.a };
      if (v.al !== undefined) {
        if (!isStr(v.al)) return at("alt al 非法");
        item.alt = v.al;
      }
      return ok(item);
    }
    case "line": {
      const ln = v.ln;
      if (
        !Array.isArray(ln) ||
        ln.length < 4 ||
        ln.length % 2 !== 0 ||
        !ln.every(isNum)
      ) {
        return at("折点 ln 非法");
      }
      if (ln.length / 2 > MAX_INK_POINTS) return at("折点过多");
      const points: [number, number][] = [];
      for (let i = 0; i < ln.length; i += 2) {
        points.push([ln[i] as number, ln[i + 1] as number]);
      }
      const item: Item = { ...base, kind: "line", points };
      if (v.as !== undefined) {
        if (v.as !== 1) return at("as 非法");
        item.arrowStart = true;
      }
      if (v.ae !== undefined) {
        if (v.ae !== 1) return at("ae 非法");
        item.arrowEnd = true;
      }
      return ok(item);
    }
  }
}

function parseJson(text: string): DecodeResult<unknown> {
  try {
    return ok(JSON.parse(text) as unknown);
  } catch {
    return fail("不是合法的 JSON");
  }
}

/** 单条 JSON 串 → 对象；坏数据返回 `{ ok: false }`，调用方忽略或清理。 */
export function decodeItem(text: string): DecodeResult<Item> {
  const json = parseJson(text);
  return json.ok ? itemFromWire(json.value) : json;
}

function referenceFromWire(v: unknown, index: number): DecodeResult<Reference> {
  if (
    !isObj(v) ||
    !isNonEmpty(v.id) ||
    !isNonEmpty(v.itemId) ||
    !isNonEmpty(v.nodeId)
  ) {
    return fail(`引用 #${index} 非法`);
  }
  return ok({ id: v.id, itemId: v.itemId, nodeId: v.nodeId });
}

export function decodeDoc(text: string): DecodeResult<BoardDoc> {
  const json = parseJson(text);
  if (!json.ok) return json;
  const doc = json.value;
  if (!isObj(doc)) return fail("文档不是 JSON 对象");
  if (doc.engine !== BOARD_ENGINE || doc.version !== BOARD_VERSION) {
    return fail("不是 armadra-board v3 文档");
  }
  if (!Array.isArray(doc.items) || !Array.isArray(doc.references)) {
    return fail("文档缺少 items 或 references");
  }
  const items: Item[] = [];
  const seen = new Set<string>();
  for (const raw of doc.items as unknown[]) {
    const item = itemFromWire(raw);
    if (!item.ok) return item;
    if (seen.has(item.value.id)) return fail(`对象 id 重复：${item.value.id}`);
    seen.add(item.value.id);
    items.push(item.value);
  }
  const references: Reference[] = [];
  for (const [i, raw] of (doc.references as unknown[]).entries()) {
    const ref = referenceFromWire(raw, i);
    if (!ref.ok) return ref;
    references.push(ref.value);
  }
  return ok({
    engine: BOARD_ENGINE,
    version: BOARD_VERSION,
    items,
    references,
  });
}
