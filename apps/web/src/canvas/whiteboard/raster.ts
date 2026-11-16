import { itemsBounds } from "./geometry";
import type { ColorScheme } from "./palette";
import type { Item } from "./model";

/**
 * 白板对象 → PNG（React Flow 计划 §2.4 / F29，归属 whiteboard）。
 *
 * 内容引用要交给 Agent 一张图（`ContextLink.content.pngPath`），旧引擎那边
 * 是编辑器自带的导出，现在得自己画。用 `OffscreenCanvas`（拿不到就退回
 * `<canvas>`），墨迹与几何形走 `Path2D`（与 SVG 节点同一份 `d`，所以导出
 * 的图和屏幕上看到的是同一条线），图片经 `fetch` → `createImageBitmap`
 * 解码——不是 `<img src>` + `drawImage`，那条路会在跨源时污染画布，
 * `toBlob` 直接抛。
 *
 * 输入校验先做完再碰 DOM：空选区、退化的包围盒、超大的画布在这里就被拒，
 * 单测不需要一个能画图的 node 环境也能覆盖这一半。
 */

/** 导出画布的最大边（像素）。再大既没人看，也会把内存打满。 */
export const MAX_RASTER_EDGE = 4096;

export interface RasterOptions {
  /** 像素密度，默认 2（Retina）。 */
  scale?: number;
  /** 四周留白（画布单位），默认 16。 */
  padding?: number;
  /** 底色；null / 省略 = 透明。 */
  background?: string | null;
  /** 取哪一套色值，默认浅色（导出的图多半贴进文档里看）。 */
  scheme?: ColorScheme;
  /** 图片对象的 `assetPath` → 可加载的 URL；拿不到就跳过那张图。 */
  resolveImage?: (assetPath: string) => string | null;
}

export class RasterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RasterError";
  }
}

export interface RasterPlan {
  x: number;
  y: number;
  /** 画布单位的宽高（不含像素密度）。 */
  w: number;
  h: number;
  scale: number;
  /** 实际的位图尺寸（已按 `MAX_RASTER_EDGE` 收过）。 */
  pixelWidth: number;
  pixelHeight: number;
}

/**
 * 算一次导出计划：包围盒 + 留白 + 密度 → 位图尺寸。
 *
 * 纯函数，所以「空选区拒绝」「超大自动降密度」这两条规则不用开画布就能
 * 测。密度是降下来的而不是把图裁掉：一张 10,000px 宽的白板导出成 4,096px
 * 仍然是完整的一张，只是细节少一点。
 */
export function planRaster(
  items: readonly Item[],
  options: RasterOptions = {},
): RasterPlan {
  if (items.length === 0) {
    throw new RasterError("nothing to rasterize");
  }
  const padding = options.padding ?? 16;
  const bounds = itemsBounds(items);
  if (!bounds) throw new RasterError("nothing to rasterize");
  const w = bounds.w + padding * 2;
  const h = bounds.h + padding * 2;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new RasterError("degenerate bounds");
  }
  const requested = options.scale ?? 2;
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new RasterError("invalid scale");
  }
  const fit = Math.min(1, MAX_RASTER_EDGE / Math.max(w, h) / requested);
  const scale = requested * (fit < 1 ? fit : 1);
  return {
    x: bounds.x - padding,
    y: bounds.y - padding,
    w,
    h,
    scale,
    pixelWidth: Math.max(1, Math.round(w * scale)),
    pixelHeight: Math.max(1, Math.round(h * scale)),
  };
}

/**
 * 把一组白板对象画成 PNG。B5 的内容引用与图片粘贴的 SVG 栅格化都用它。
 *
 * 绘制交给引擎（`board/whiteboard/export`，与屏幕同一套 `paint`）；这里先做
 * 输入校验——空选区、退化的包围盒、不合法的密度在碰 DOM 之前就被拒。引擎那份
 * 代码动态加载：`current` 画布的首屏不为导出拖进整个引擎。
 */
export async function rasterizeItems(
  items: readonly Item[],
  options: RasterOptions = {},
): Promise<Blob> {
  planRaster(items, options);
  const { exportItemsPng } = await import("../board/whiteboard/export");
  return exportItemsPng(items, options);
}
