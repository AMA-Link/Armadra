// 四层结构（docs/design/board-engine.md §2.7）：
// Canvas 下带 → DOM 世界层 → Canvas 上带 → 叠加层（世界坐标 SVG + 屏幕坐标插槽）。
import type { CameraState } from "../../core";
import { browserEnv, type RenderEnv } from "./env";

export interface LayerSize {
  width: number;
  height: number;
  dpr: number;
}

export interface Layers {
  readonly root: HTMLElement;
  readonly under: HTMLCanvasElement;
  /** 世界层：`transform: translate() scale()` 跟相机；子元素由 WorldHosts 管。 */
  readonly world: HTMLElement;
  readonly over: HTMLCanvasElement;
  /** 叠加层容器：`pointer-events: none`，里面的可交互元素自己打开。 */
  readonly overlay: HTMLElement;
  /** 叠加层里的世界坐标 SVG（连线、预览线）：与世界层同一个变换。 */
  readonly worldSvg: SVGSVGElement;
  /** 叠加层里的屏幕坐标插槽（选框、把手、光标、评论钉）。 */
  readonly screenSlot: HTMLElement;
  size(): LayerSize;
  setCamera(camera: CameraState): void;
  /** 容器尺寸或 DPR 变化后调用的回调；返回退订。 */
  onResize(listener: (size: LayerSize) => void): () => void;
  /** 重新量尺寸与 DPR 并改 Canvas 像素尺寸（DPR 变化没有事件，由外部在合适时机调用）。 */
  refresh(): void;
  destroy(): void;
}

const FILL = "position:absolute;left:0;top:0;width:100%;height:100%;";

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  layer: string,
  css: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.dataset.boardLayer = layer;
  el.style.cssText = css;
  return el;
}

export function createLayers(
  container: HTMLElement,
  env: RenderEnv = browserEnv(),
): Layers {
  if (getComputedStyle(container).position === "static") {
    container.style.position = "relative";
  }
  container.style.overflow = "hidden";

  const under = element("canvas", "canvas-under", FILL + "pointer-events:none");
  const world = element(
    "div",
    "world",
    "position:absolute;left:0;top:0;width:0;height:0;overflow:visible;transform-origin:0 0;",
  );
  const over = element("canvas", "canvas-over", FILL + "pointer-events:none");
  const overlay = element("div", "overlay", FILL + "pointer-events:none");
  const svgNs = "http://www.w3.org/2000/svg";
  const worldSvg = document.createElementNS(svgNs, "svg");
  worldSvg.dataset.boardLayer = "overlay-world";
  worldSvg.style.cssText =
    "position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;transform-origin:0 0;pointer-events:none;";
  const screenSlot = element("div", "overlay-screen", FILL);
  overlay.append(worldSvg, screenSlot);
  container.append(under, world, over, overlay);

  const listeners = new Set<(size: LayerSize) => void>();
  let size: LayerSize = { width: 0, height: 0, dpr: 1 };

  function refresh(): void {
    const next = {
      width: container.clientWidth,
      height: container.clientHeight,
      dpr: env.dpr(),
    };
    const same =
      next.width === size.width &&
      next.height === size.height &&
      next.dpr === size.dpr;
    size = next;
    for (const canvas of [under, over]) {
      canvas.width = Math.max(1, Math.round(next.width * next.dpr));
      canvas.height = Math.max(1, Math.round(next.height * next.dpr));
    }
    if (!same) for (const listener of [...listeners]) listener(next);
  }

  refresh();
  const stopObserving = env.observe(container, refresh);

  return {
    root: container,
    under,
    world,
    over,
    overlay,
    worldSvg,
    screenSlot,
    size: () => size,
    setCamera(camera) {
      const transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`;
      world.style.transform = transform;
      worldSvg.style.transform = transform;
    },
    onResize(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    destroy() {
      stopObserving();
      listeners.clear();
      under.remove();
      world.remove();
      over.remove();
      overlay.remove();
    },
  };
}
