// Canvas 绘制：按层收集 KindSpec.paint，只画相机可见区域内的对象，rAF 里重绘。
// 每层的对象先画进一张比视口四周各大 `PAD` 的离屏位图；只平移相机时整张贴图
// 挪个位置，不重画对象——墨迹多的板平移不再每帧重算几百条路径。
import {
  rectInflate,
  type Entity,
  type EntityId,
  type Scene,
} from "../../core";
import type { Camera, DomKindSpec, DomPaintEnv } from "../types";
import { browserEnv, type RenderEnv } from "./env";
import type { Layers } from "./layers";

/** 点阵间距（世界单位）；缩小到点距小于 `MIN_DOT_PITCH` 像素后间距翻倍。 */
export const DOT_GAP = 20;
export const MIN_DOT_PITCH = 10;
/** 一屏最多画这么多点，超过就继续稀疏化。 */
const MAX_DOTS = 20000;
/** 可见区向外多画一圈（屏幕像素）：描边、阴影超出包围盒时不在边缘突然消失。 */
const BLEED = 16;
/** 离屏位图比视口四周各多出的屏幕像素；平移超出这一圈才重画。 */
export const PAD = 256;

interface LayerCache {
  surface: HTMLCanvasElement | null;
  x: number;
  y: number;
  zoom: number;
  width: number;
  height: number;
  dpr: number;
}

export interface PaintSettings {
  theme: "light" | "dark";
  dots: boolean;
  /** 颜色名 → CSS 颜色；`dot` 是点阵色。缺省原样返回。 */
  color(name: string): string;
  /** 资源位图；没到位返回 undefined，到位后由应用调用 `invalidate()`。 */
  image(key: string): CanvasImageSource | undefined;
  selected(id: EntityId): boolean;
}

export interface PainterDeps {
  layers: Layers;
  scene: Scene;
  camera: Camera;
  kind(kind: string): DomKindSpec | undefined;
  env?: RenderEnv;
  settings?: Partial<PaintSettings>;
}

export interface Painter {
  /** 标脏并在下一帧重绘；一帧内多次调用只绘一次。 */
  invalidate(): void;
  /** 立即重绘（取消排队的那一帧）。 */
  flush(): void;
  configure(settings: Partial<PaintSettings>): void;
  destroy(): void;
}

/** 点阵的实际世界间距：缩得越小越稀。 */
export function dotGap(zoom: number, width: number, height: number): number {
  if (!(zoom > 0)) return DOT_GAP;
  let gap = DOT_GAP;
  while (
    gap * zoom < MIN_DOT_PITCH ||
    (width * height) / (gap * zoom) ** 2 > MAX_DOTS
  ) {
    gap *= 2;
  }
  return gap;
}

export function createPainter(deps: PainterDeps): Painter {
  const { layers, scene, camera } = deps;
  const env = deps.env ?? browserEnv();
  let settings: PaintSettings = {
    theme: "light",
    dots: true,
    // 点阵缺省按主题取一档半透明灰；应用想要自己的色就传 `color`。
    color: (name) =>
      name === "dot"
        ? settings.theme === "dark"
          ? "rgba(255,255,255,0.18)"
          : "rgba(0,0,0,0.18)"
        : name,
    image: () => undefined,
    selected: () => false,
    ...deps.settings,
  };
  let pending: number | null = null;

  function drawDots(
    ctx: CanvasRenderingContext2D,
    cam: { x: number; y: number; zoom: number },
    width: number,
    height: number,
  ): void {
    const pitch = dotGap(cam.zoom, width, height) * cam.zoom;
    const radius = Math.min(1.25, Math.max(0.6, cam.zoom));
    const startX = ((cam.x % pitch) + pitch) % pitch;
    const startY = ((cam.y % pitch) + pitch) % pitch;
    ctx.fillStyle = settings.color("dot");
    ctx.beginPath();
    for (let x = startX; x < width; x += pitch) {
      for (let y = startY; y < height; y += pitch) {
        ctx.rect(x - radius, y - radius, radius * 2, radius * 2);
      }
    }
    ctx.fill();
  }

  const caches = new Map<string, LayerCache>();
  let dirty = true;

  function fresh(
    cache: LayerCache | undefined,
    cam: { x: number; y: number; zoom: number },
    width: number,
    height: number,
    dpr: number,
  ): boolean {
    return (
      !dirty &&
      !!cache &&
      cache.zoom === cam.zoom &&
      cache.dpr === dpr &&
      cache.width === width &&
      cache.height === height &&
      Math.abs(cam.x - cache.x) <= PAD &&
      Math.abs(cam.y - cache.y) <= PAD
    );
  }

  function frame(): void {
    pending = null;
    const { width, height, dpr } = layers.size();
    const cam = camera.get();
    let hits: Entity[] | null = null;
    const paintEnv: DomPaintEnv = {
      zoom: cam.zoom,
      dpr,
      theme: settings.theme,
      color: settings.color,
      image: settings.image,
      selected: false,
    };
    for (const [canvas, layer] of [
      [layers.under, "canvas-under"],
      [layers.over, "canvas-over"],
    ] as const) {
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (layer === "canvas-under" && settings.dots) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawDots(ctx, cam, width, height);
      }
      let cache = caches.get(layer);
      if (!fresh(cache, cam, width, height, dpr)) {
        hits ??= scene.query(
          rectInflate(camera.visible(), (PAD + BLEED) / (cam.zoom || 1)),
        );
        const mine = hits.filter((entity) => {
          const spec = deps.kind(entity.kind);
          return spec?.layer === layer && !!spec.paint;
        });
        let surface = cache?.surface ?? null;
        if (mine.length && !surface) surface = document.createElement("canvas");
        if (!mine.length) surface = null;
        cache = {
          surface,
          x: cam.x,
          y: cam.y,
          zoom: cam.zoom,
          width,
          height,
          dpr,
        };
        caches.set(layer, cache);
        const sctx = surface?.getContext("2d");
        if (surface && sctx) {
          const w = Math.round((width + 2 * PAD) * dpr);
          const h = Math.round((height + 2 * PAD) * dpr);
          if (surface.width !== w || surface.height !== h) {
            surface.width = w;
            surface.height = h;
          } else {
            sctx.setTransform(1, 0, 0, 1, 0, 0);
            sctx.clearRect(0, 0, w, h);
          }
          sctx.setTransform(
            dpr * cam.zoom,
            0,
            0,
            dpr * cam.zoom,
            dpr * (cam.x + PAD),
            dpr * (cam.y + PAD),
          );
          for (const entity of mine) {
            const box = scene.bounds(entity.id);
            if (!box) continue;
            sctx.save();
            // 绘制收到的是绝对世界几何（含预览与父级偏移）。
            deps.kind(entity.kind)!.paint!(
              sctx,
              { ...entity, ...box },
              { ...paintEnv, selected: settings.selected(entity.id) },
            );
            sctx.restore();
          }
        }
      }
      if (!cache?.surface) continue;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      // 贴图偏移取整到设备像素：不做插值，静止时与重画结果逐像素一致。
      ctx.drawImage(
        cache.surface,
        Math.round(dpr * (cam.x - cache.x - PAD)),
        Math.round(dpr * (cam.y - cache.y - PAD)),
      );
    }
    dirty = false;
  }

  const schedule = (): void => {
    pending ??= env.raf(frame);
  };
  const invalidate = (): void => {
    dirty = true;
    schedule();
  };
  const stops = [
    // 只动相机：贴图挪位置，位图过期（缩放变了、平移出圈）时 frame 自己重画。
    camera.subscribe(schedule),
    scene.subscribe((changed) => {
      // 只有 Canvas 层的实体或已经不存在的实体（可能刚从 Canvas 层移除）才需要重绘。
      for (const id of changed) {
        const entity = scene.get(id);
        const layer = entity && deps.kind(entity.kind)?.layer;
        if (!entity || layer === "canvas-under" || layer === "canvas-over") {
          invalidate();
          return;
        }
      }
    }),
  ];
  invalidate();

  return {
    invalidate,
    flush() {
      if (pending !== null) env.caf(pending);
      frame();
    },
    configure(next) {
      settings = { ...settings, ...next };
      invalidate();
    },
    destroy() {
      for (const stop of stops) stop();
      if (pending !== null) env.caf(pending);
      pending = null;
      caches.clear();
    },
  };
}
