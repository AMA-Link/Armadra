// 缩略图：Canvas 画全部实体的包围盒与可见框；点击 / 拖动可视框移动相机。
import {
  rectCenter,
  rectContainsPoint,
  rectUnion,
  type Entity,
  type Rect,
  type Scene,
  type Vec,
} from "../../core";
import { browserEnv, type RenderEnv } from "../render/env";
import type { Camera } from "../types";

export interface MinimapStyle {
  fill: string;
  stroke?: string;
  strokeWidth?: number;
}

export interface MinimapDeps {
  scene: Scene;
  camera: Camera;
  /** 实体的颜色（应用传状态配色）；`null` 不画。字符串 = 只填充。连线取 `stroke`。 */
  colorOf(entity: Entity): MinimapStyle | string | null;
  /** 把相机移到这个世界坐标（视口中心）；缺省 `camera.center`。 */
  onNavigate?(center: Vec): void;
  /** 视口外的遮罩色与可见框描边色。 */
  colors?: { mask: string; frame: string };
  env?: RenderEnv;
}

export interface Minimap {
  invalidate(): void;
  /** 立即重绘。 */
  flush(): void;
  destroy(): void;
}

/** 缩略图内容与边缘的留白（像素）。 */
export const MINIMAP_MARGIN = 6;

export interface MinimapView {
  scale: number;
  /** 世界坐标 (x, y) → 画布像素：`(x - origin.x) * scale`。 */
  origin: Vec;
}

/** 把范围居中缩放进 `size`；范围退化时按 1:1。 */
export function minimapView(
  extent: Rect,
  size: { width: number; height: number },
  margin = MINIMAP_MARGIN,
): MinimapView {
  const innerW = Math.max(1, size.width - margin * 2);
  const innerH = Math.max(1, size.height - margin * 2);
  const scale = Math.min(
    innerW / Math.max(extent.w, 1),
    innerH / Math.max(extent.h, 1),
  );
  return {
    scale,
    origin: {
      x: extent.x - (size.width / scale - extent.w) / 2,
      y: extent.y - (size.height / scale - extent.h) / 2,
    },
  };
}

export function createMinimap(el: HTMLElement, deps: MinimapDeps): Minimap {
  const { scene, camera } = deps;
  const env = deps.env ?? browserEnv();
  const colors = deps.colors ?? {
    mask: "rgba(0,0,0,0.12)",
    frame: "rgba(128,128,128,0.9)",
  };
  const canvas = document.createElement("canvas");
  canvas.dataset.boardLayer = "minimap";
  canvas.style.cssText =
    "position:absolute;left:0;top:0;width:100%;height:100%;";
  el.append(canvas);
  let pending: number | null = null;
  let size = { width: 0, height: 0 };
  let view: MinimapView = { scale: 1, origin: { x: 0, y: 0 } };

  const boxes = (): Array<[Entity, Rect]> => {
    const out: Array<[Entity, Rect]> = [];
    for (const entity of scene.ordered()) {
      const box = scene.bounds(entity.id);
      if (box && !entity.ends) out.push([entity, box]);
    }
    return out;
  };
  const toPx = (p: Vec): Vec => ({
    x: (p.x - view.origin.x) * view.scale,
    y: (p.y - view.origin.y) * view.scale,
  });
  const toWorld = (p: Vec): Vec => ({
    x: p.x / view.scale + view.origin.x,
    y: p.y / view.scale + view.origin.y,
  });

  function measure(): number {
    size = { width: el.clientWidth, height: el.clientHeight };
    const dpr = env.dpr();
    const [w, h] = [
      Math.max(1, Math.round(size.width * dpr)),
      Math.max(1, Math.round(size.height * dpr)),
    ];
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    return dpr;
  }

  function frame(): void {
    pending = null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = measure();
    const visible = camera.visible();
    const items = boxes();
    let extent = visible;
    for (const [, box] of items) extent = rectUnion(extent, box);
    view = minimapView(extent, size);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    for (const entity of scene.ordered()) {
      const style = deps.colorOf(entity);
      if (!style) continue;
      const { fill, stroke, strokeWidth } =
        typeof style === "string" ? ({ fill: style } as MinimapStyle) : style;
      if (entity.ends) {
        const [a, b] = entity.ends.map((id) => scene.bounds(id));
        if (!a || !b || !stroke) continue;
        const from = toPx(rectCenter(a));
        const to = toPx(rectCenter(b));
        ctx.strokeStyle = stroke;
        ctx.lineWidth = strokeWidth ?? 1;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
        continue;
      }
      const box = scene.bounds(entity.id);
      if (!box) continue;
      const p = toPx(box);
      const [w, h] = [
        Math.max(1, box.w * view.scale),
        Math.max(1, box.h * view.scale),
      ];
      ctx.fillStyle = fill;
      ctx.fillRect(p.x, p.y, w, h);
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = strokeWidth ?? 1;
        ctx.strokeRect(p.x, p.y, w, h);
      }
    }
    const v = toPx(visible);
    ctx.fillStyle = colors.mask;
    ctx.beginPath();
    ctx.rect(0, 0, size.width, size.height);
    ctx.rect(v.x, v.y, visible.w * view.scale, visible.h * view.scale);
    ctx.fill("evenodd");
    ctx.strokeStyle = colors.frame;
    ctx.lineWidth = 1;
    ctx.strokeRect(v.x, v.y, visible.w * view.scale, visible.h * view.scale);
  }

  const invalidate = (): void => {
    pending ??= env.raf(frame);
  };

  const navigate = (center: Vec): void =>
    deps.onNavigate ? deps.onNavigate(center) : camera.center(center);
  const local = (event: PointerEvent): Vec => {
    const rect = el.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  /** 拖动时指针相对可视框中心的偏移（世界单位）；`null` = 没有在拖。 */
  let grab: Vec | null = null;

  const onDown = (event: PointerEvent): void => {
    if (event.button > 0) return;
    const world = toWorld(local(event));
    const visible = camera.visible();
    const centre = rectCenter(visible);
    if (rectContainsPoint(visible, world)) {
      grab = { x: world.x - centre.x, y: world.y - centre.y };
    } else {
      // 点到实体 → 居中到它；点到空白 → 居中到点击处。
      const hit = scene
        .query({ x: world.x, y: world.y, w: 0, h: 0 }, (e) => !e.ends)
        .at(-1);
      const target = hit && scene.bounds(hit.id);
      navigate(target ? rectCenter(target) : world);
      grab = { x: 0, y: 0 };
    }
    el.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };
  const onMove = (event: PointerEvent): void => {
    if (!grab) return;
    const world = toWorld(local(event));
    navigate({ x: world.x - grab.x, y: world.y - grab.y });
  };
  const onUp = (): void => {
    grab = null;
  };
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);

  const stops = [
    camera.subscribe(invalidate),
    scene.subscribe(invalidate),
    env.observe(el, invalidate),
  ];
  invalidate();

  return {
    invalidate,
    flush() {
      if (pending !== null) env.caf(pending);
      frame();
    },
    destroy() {
      for (const stop of stops) stop();
      if (pending !== null) env.caf(pending);
      pending = null;
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      canvas.remove();
    },
  };
}
