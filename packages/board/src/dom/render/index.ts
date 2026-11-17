// 渲染线入口：把分层、Canvas 绘制、世界层宿主接到相机与场景上。
import type { Scene } from "../../core";
import type { Camera, DomKindSpec } from "../types";
import { browserEnv, type RenderEnv } from "./env";
import { createWorldHosts, type WorldHosts } from "./hosts";
import { createLayers, type Layers } from "./layers";
import { createPainter, type PaintSettings, type Painter } from "./painter";

export { browserEnv, type RenderEnv } from "./env";
export { createLayers, type Layers, type LayerSize } from "./layers";
export { createPainter, type PaintSettings, type Painter } from "./painter";
export { createWorldHosts, type WorldHosts } from "./hosts";
export { layoutText, type MeasureText, type TextLayout } from "./text";

export interface RendererDeps {
  scene: Scene;
  camera: Camera;
  kind(kind: string): DomKindSpec | undefined;
  env?: RenderEnv;
  settings?: Partial<PaintSettings>;
}

export interface Renderer {
  readonly layers: Layers;
  readonly hosts: WorldHosts;
  readonly painter: Painter;
  destroy(): void;
}

/** 建四层并接线：相机 → 世界层 transform 与 Canvas 重绘；容器尺寸 → 相机视口。 */
export function createRenderer(
  container: HTMLElement,
  deps: RendererDeps,
): Renderer {
  const env = deps.env ?? browserEnv();
  const layers = createLayers(container, env);
  const hosts = createWorldHosts({
    world: layers.world,
    scene: deps.scene,
    kind: deps.kind,
  });
  const painter = createPainter({ ...deps, layers, env });
  const { camera } = deps;
  const applySize = (): void => camera.setViewport(layers.size());
  applySize();
  layers.setCamera(camera.get());
  const stops = [
    layers.onResize(() => {
      applySize();
      painter.invalidate();
    }),
    camera.subscribe((state) => layers.setCamera(state)),
  ];
  return {
    layers,
    hosts,
    painter,
    destroy() {
      for (const stop of stops) stop();
      painter.destroy();
      hosts.destroy();
      layers.destroy();
    },
  };
}
