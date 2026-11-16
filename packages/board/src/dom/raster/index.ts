// 栅格导出：离屏 Canvas 用与屏幕同一套 `paint` 绘制，得到 PNG。
import {
  rectInflate,
  rectsBounds,
  type EntityId,
  type Scene,
} from "../../core";
import type { DomKindSpec, RasterOptions } from "../types";

/** 导出位图的最大边（像素）；超出时降低像素密度而不是裁剪。 */
export const MAX_RASTER_EDGE = 4096;
export const DEFAULT_RASTER_SCALE = 2;
export const DEFAULT_RASTER_PADDING = 16;

export class RasterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RasterError";
  }
}

/** `OffscreenCanvas` 与 `HTMLCanvasElement` 共有的最小面。 */
export interface RasterSurface {
  width: number;
  height: number;
  getContext(type: "2d"): CanvasRenderingContext2D | null;
}

export interface RasterEnv {
  createSurface(width: number, height: number): RasterSurface;
  toBlob(surface: RasterSurface): Promise<Blob>;
  theme?: "light" | "dark";
  color?(name: string): string;
  image?(key: string): CanvasImageSource | undefined;
  /** 绘制前等资源位图就绪（图片对象）。 */
  prepare?(ids: readonly EntityId[]): Promise<void>;
}

export interface RasterPlan {
  x: number;
  y: number;
  /** 世界单位的宽高（含留白）。 */
  w: number;
  h: number;
  /** 实际像素密度（已按 `MAX_RASTER_EDGE` 收过）。 */
  scale: number;
  pixelWidth: number;
  pixelHeight: number;
}

/** 包围盒 + 留白 + 密度 → 位图尺寸；纯函数。 */
export function planRaster(
  bounds: { x: number; y: number; w: number; h: number },
  options: RasterOptions = {},
): RasterPlan {
  const padding = options.padding ?? DEFAULT_RASTER_PADDING;
  const box = rectInflate(bounds, padding);
  if (!(box.w > 0 && box.h > 0)) throw new RasterError("empty bounds");
  const wanted = options.scale ?? DEFAULT_RASTER_SCALE;
  const scale = Math.min(
    wanted,
    MAX_RASTER_EDGE / box.w,
    MAX_RASTER_EDGE / box.h,
  );
  return {
    ...box,
    scale,
    pixelWidth: Math.max(1, Math.round(box.w * scale)),
    pixelHeight: Math.max(1, Math.round(box.h * scale)),
  };
}

export async function rasterize(
  scene: Scene,
  kinds: (kind: string) => DomKindSpec | undefined,
  ids: readonly EntityId[],
  options: RasterOptions,
  env: RasterEnv,
): Promise<Blob> {
  const wanted = new Set(ids);
  const entities = scene
    .ordered()
    .filter((e) => wanted.has(e.id) && !e.ends && scene.bounds(e.id));
  if (entities.length === 0) throw new RasterError("nothing to rasterize");
  const bounds = rectsBounds(entities.map((e) => scene.bounds(e.id)!))!;
  const plan = planRaster(bounds, options);
  await env.prepare?.(entities.map((e) => e.id));

  const surface = env.createSurface(plan.pixelWidth, plan.pixelHeight);
  const ctx = surface.getContext("2d");
  if (!ctx) throw new RasterError("no 2d context");
  const background = options.background ?? null;
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, plan.pixelWidth, plan.pixelHeight);
  }
  ctx.setTransform(
    plan.scale,
    0,
    0,
    plan.scale,
    -plan.x * plan.scale,
    -plan.y * plan.scale,
  );
  const paintEnv = {
    zoom: 1,
    dpr: plan.scale,
    // 导出的图多半贴进文档里看，缺省浅色。
    theme: env.theme ?? "light",
    color: env.color ?? ((name: string) => name),
    image: env.image ?? (() => undefined),
    selected: false,
  };
  for (const entity of entities) {
    const paint = kinds(entity.kind)?.paint;
    if (!paint) continue;
    ctx.save();
    paint(ctx, { ...entity, ...scene.bounds(entity.id)! }, paintEnv);
    ctx.restore();
  }
  return env.toBlob(surface);
}

/** 浏览器里的默认环境：优先 `OffscreenCanvas`，退回 `<canvas>`。 */
export function browserRasterEnv(
  extra: Omit<RasterEnv, "createSurface" | "toBlob"> = {},
): RasterEnv {
  return {
    ...extra,
    createSurface(width, height) {
      if (typeof OffscreenCanvas !== "undefined") {
        return new OffscreenCanvas(width, height) as unknown as RasterSurface;
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      return canvas;
    },
    toBlob(surface) {
      if ("convertToBlob" in surface) {
        return (surface as unknown as OffscreenCanvas).convertToBlob({
          type: "image/png",
        });
      }
      return new Promise((resolve, reject) =>
        (surface as HTMLCanvasElement).toBlob(
          (blob) =>
            blob ? resolve(blob) : reject(new RasterError("toBlob failed")),
          "image/png",
        ),
      );
    },
  };
}
