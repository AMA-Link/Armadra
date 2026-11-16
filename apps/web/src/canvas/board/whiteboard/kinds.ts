import type { CanvasNode } from "@armadra/shared";
import type { Entity } from "@armadra/board/core";
import type { DomKindSpec, DomPaintEnv } from "@armadra/board/dom";

import { isOverBand } from "../../whiteboard/bands";
import { arrowHead, geoPath, hitTestItem } from "../../whiteboard/geometry";
import { inkPath } from "../../whiteboard/ink";
import type { Item } from "../../whiteboard/model";
import {
  dashArray,
  fillOpacity,
  fontSize,
  HIGHLIGHT_OPACITY,
  HIGHLIGHT_SCALE,
  strokeWidth,
} from "../../whiteboard/palette";
import { fontOf, layoutFor, TEXT_PAD } from "./text";
import { getEditing } from "./text-edit";

/**
 * 五种白板对象的引擎种类（设计 §2.3 / §2.7）：`paint` 用 Canvas2D，屏幕与 PNG 导出
 * 是同一个函数；`hit` 精确到线与形状轮廓；`resize` 按种类约束。
 *
 * `paint` 收到的实体已是绝对世界几何（含手势预览）；`entity.data` 是文档里的
 * `Item`，所以「当前几何 / 文档几何」之比就是预览中的缩放比，墨迹与直线靠它在
 * 手势中跟手（落成后文档再给新的 `Item`）。
 */

export const WB_PREFIX = "wb.";
export const OVER_SUFFIX = ":over";

type WbEntity = Entity<Item>;
type Ctx = CanvasRenderingContext2D;

/** 对象在引擎里的 `kind`：种类 + 遮挡带。 */
export function wbKindOf(item: Item): string {
  return `${WB_PREFIX}${item.kind}${isOverBand(item.z) ? OVER_SUFFIX : ""}`;
}

export function isWbKind(kind: string): boolean {
  return kind.startsWith(WB_PREFIX);
}

/* -------------------------------- 缓存 ------------------------------------ */

const paths = new WeakMap<object, { key: string; path: Path2D }>();

/** 按（对象身份，参数键）缓存 Path2D；对象或参数变了才重算。 */
function cachedPath(owner: object, key: string, build: () => string): Path2D {
  const hit = paths.get(owner);
  if (hit && hit.key === key) return hit.path;
  const path = new Path2D(build());
  paths.set(owner, { key, path });
  return path;
}

const dashOf = (dash: string | undefined, width: number): number[] => {
  const spec = dashArray(dash as never, width);
  return spec ? spec.split(" ").map(Number) : [];
};

/** 墨迹点集所在的原始盒：缩放比是「现在的盒 / 原始盒」。 */
const originOf = (item: Item): { w: number; h: number } => {
  const o = (item as { origin?: { w: number; h: number } }).origin;
  return { w: o?.w || item.w || 1, h: o?.h || item.h || 1 };
};

/* -------------------------------- paint ----------------------------------- */

function paintInk(
  ctx: Ctx,
  e: WbEntity,
  env: DomPaintEnv,
  item: Extract<Item, { kind: "ink" }>,
): void {
  const base = strokeWidth(item.style.size);
  const size = item.highlight ? base * HIGHLIGHT_SCALE : base;
  const path = cachedPath(item, `${size}`, () =>
    inkPath(item.points, { size, highlight: item.highlight }),
  );
  const o = originOf(item);
  ctx.translate(e.x, e.y);
  ctx.scale(e.w / o.w, e.h / o.h);
  // 只用透明度，不用 multiply：屏幕上 Canvas 层是透明的，混合不到底下的内容，
  // 而导出带底色，两边会不一致。
  if (item.highlight) ctx.globalAlpha = HIGHLIGHT_OPACITY;
  ctx.fillStyle = env.color(item.style.color);
  ctx.fill(path);
}

function paintLabel(
  ctx: Ctx,
  e: WbEntity,
  env: DomPaintEnv,
  text: string,
  align: "start" | "middle" | "end",
  middle: boolean,
  size: number,
): void {
  const { lines, lineHeight } = layoutFor(e.data, text, e.w, size);
  ctx.font = fontOf(size);
  ctx.fillStyle = env.color(e.data.style.color);
  ctx.textBaseline = "top";
  ctx.textAlign =
    align === "middle" ? "center" : align === "end" ? "right" : "left";
  const x =
    align === "middle"
      ? e.x + e.w / 2
      : align === "end"
        ? e.x + e.w - TEXT_PAD
        : e.x + TEXT_PAD;
  const top = middle
    ? e.y + (e.h - lines.length * lineHeight) / 2
    : e.y + TEXT_PAD;
  lines.forEach((line, i) => ctx.fillText(line, x, top + i * lineHeight));
}

function paintShape(
  ctx: Ctx,
  e: WbEntity,
  env: DomPaintEnv,
  item: Extract<Item, { kind: "shape" }>,
): void {
  if (!(e.w > 0 && e.h > 0)) return;
  const width = strokeWidth(item.style.size);
  const color = env.color(item.style.color);
  const path = cachedPath(
    item,
    `${Math.round(e.w * 10)}x${Math.round(e.h * 10)}`,
    () => geoPath(item.geo, e.w, e.h),
  );
  ctx.translate(e.x, e.y);
  const opacity = fillOpacity(item.style.fill);
  if (opacity > 0) {
    ctx.globalAlpha = opacity;
    ctx.fillStyle = color;
    ctx.fill(path);
    ctx.globalAlpha = 1;
  }
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.lineJoin = "round";
  ctx.setLineDash(dashOf(item.style.dash, width));
  ctx.stroke(path);
  ctx.translate(-e.x, -e.y);
  const editing = getEditing();
  if (item.label && !(editing?.id === e.id && editing.field === "label")) {
    paintLabel(
      ctx,
      e,
      env,
      item.label,
      "middle",
      true,
      fontSize(item.style.size),
    );
  }
}

function paintLine(
  ctx: Ctx,
  e: WbEntity,
  env: DomPaintEnv,
  item: Extract<Item, { kind: "line" }>,
): void {
  if (item.points.length < 2) return;
  const sx = e.w / (item.w || 1);
  const sy = e.h / (item.h || 1);
  const pts = item.points.map(
    ([x, y]) => [e.x + x * sx, e.y + y * sy] as [number, number],
  );
  const width = strokeWidth(item.style.size);
  ctx.lineWidth = width;
  ctx.strokeStyle = env.color(item.style.color);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.setLineDash(dashOf(item.style.dash, width));
  ctx.beginPath();
  ctx.moveTo(pts[0]![0], pts[0]![1]);
  for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
  ctx.stroke();
  ctx.setLineDash([]);
  const head = width * 3 + 4;
  const last = pts.length - 1;
  if (item.arrowEnd)
    ctx.stroke(new Path2D(arrowHead(pts[last]!, pts[last - 1]!, head)));
  if (item.arrowStart)
    ctx.stroke(new Path2D(arrowHead(pts[0]!, pts[1]!, head)));
}

function paintImage(
  ctx: Ctx,
  e: WbEntity,
  env: DomPaintEnv,
  item: Extract<Item, { kind: "image" }>,
): void {
  const bitmap = env.image(item.assetPath);
  if (bitmap) {
    ctx.drawImage(bitmap, e.x, e.y, e.w, e.h);
    return;
  }
  // 位图没到位（或资产没了）：留一个占位，到位后引擎重绘。
  ctx.strokeStyle = env.color("grey");
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(e.x, e.y, e.w, e.h);
}

function paint(ctx: Ctx, e: WbEntity, env: DomPaintEnv): void {
  const item = e.data;
  switch (item.kind) {
    case "ink":
      return paintInk(ctx, e, env, item);
    case "shape":
      return paintShape(ctx, e, env, item);
    case "line":
      return paintLine(ctx, e, env, item);
    case "image":
      return paintImage(ctx, e, env, item);
    case "text": {
      const editing = getEditing();
      if (!item.text || (editing?.id === e.id && editing.field === "text"))
        return;
      return paintLabel(
        ctx,
        e,
        env,
        item.text,
        item.style.align ?? "start",
        false,
        fontSize(item.style.size),
      );
    }
  }
}

/* --------------------------------- hit ------------------------------------ */

/** 命中：点换算到文档几何的坐标系（墨迹 / 直线手势中被缩放过），再用 `hitTestItem`。 */
function hit(
  e: WbEntity,
  point: { x: number; y: number },
  _tolerance: number,
): boolean {
  const item = e.data;
  const o =
    item.kind === "ink" ? originOf(item) : { w: item.w || 1, h: item.h || 1 };
  const kx = o.w / (e.w || 1);
  const ky = o.h / (e.h || 1);
  const local = { ...item, x: 0, y: 0, w: o.w, h: o.h } as Item;
  const lx = (point.x - e.x) * kx;
  const ly = (point.y - e.y) * ky;
  if (item.kind === "shape") {
    return hitTestItem(
      { ...item, x: 0, y: 0, w: e.w, h: e.h },
      point.x - e.x,
      point.y - e.y,
    );
  }
  return hitTestItem(local, lx, ly);
}

/* -------------------------------- 注册 ------------------------------------ */

const SPECS: Record<Item["kind"], Omit<DomKindSpec<Item>, "layer">> = {
  ink: { paint, hit, resize: { min: { w: 8, h: 8 } } },
  shape: { paint, hit, resize: { min: { w: 8, h: 8 } } },
  text: { paint, resize: { min: { w: 40, h: 24 }, widthOnly: true } },
  image: { paint, resize: { min: { w: 8, h: 8 }, keepAspect: true } },
  line: { paint, hit, resize: false },
};

/** 白板对象只能当连线落点（旧引擎的 `dropOnly` 把手），不能起笔。 */
const CONNECT = { start: false, end: true } as const;

/** 全部白板种类：每种两档（下带 / 上带），`kind` 名见 `wbKindOf`。 */
export function whiteboardKinds(): Record<string, DomKindSpec<CanvasNode>> {
  const kinds: Record<string, DomKindSpec<Item>> = {};
  for (const [name, spec] of Object.entries(SPECS)) {
    kinds[`${WB_PREFIX}${name}`] = {
      ...spec,
      connect: CONNECT,
      layer: "canvas-under",
    };
    kinds[`${WB_PREFIX}${name}${OVER_SUFFIX}`] = {
      ...spec,
      connect: CONNECT,
      layer: "canvas-over",
    };
  }
  return kinds as unknown as Record<string, DomKindSpec<CanvasNode>>;
}
