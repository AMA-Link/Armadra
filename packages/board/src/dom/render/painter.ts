// Canvas 绘制：按层收集 KindSpec.paint，只画相机可见区域内的对象，rAF 里重绘。
import { rectInflate, type EntityId, type Scene } from "../../core";
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

  function frame(): void {
    pending = null;
    const { width, height, dpr } = layers.size();
    const cam = camera.get();
    const visible = rectInflate(camera.visible(), BLEED / (cam.zoom || 1));
    const hits = scene.query(visible);
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
      ctx.setTransform(
        dpr * cam.zoom,
        0,
        0,
        dpr * cam.zoom,
        dpr * cam.x,
        dpr * cam.y,
      );
      for (const entity of hits) {
        const spec = deps.kind(entity.kind);
        const box = scene.bounds(entity.id);
        if (spec?.layer !== layer || !spec.paint || !box) continue;
        ctx.save();
        // 绘制收到的是绝对世界几何（含预览与父级偏移）。
        spec.paint(
          ctx,
          { ...entity, ...box },
          {
            ...paintEnv,
            selected: settings.selected(entity.id),
          },
        );
        ctx.restore();
      }
    }
  }

  const invalidate = (): void => {
    pending ??= env.raf(frame);
  };
  const stops = [
    camera.subscribe(invalidate),
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
    },
  };
}
