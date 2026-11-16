import { storedEnum, writeStored } from "./storage";

/**
 * 画布引擎（docs/design/board-engine.md §6.1 B3）。
 *
 * `current` 是现行的 React Flow 画布；`next` 是自研画板引擎，B3 起放在这个开关
 * 后面自己日用。缺省 `current`，设置页不露出：切换走本地存储
 * （`localStorage["armadra.canvas.engine"]`，刷新后生效）或调试把手
 * `window.__armadraCanvasEngine.set("next")`（立刻生效，画布会重新挂载）。
 */
export const CANVAS_ENGINES = ["current", "next"] as const;
export type CanvasEngine = (typeof CANVAS_ENGINES)[number];

export const CANVAS_ENGINE_KEY = "armadra.canvas.engine";

export function storedCanvasEngine(): CanvasEngine {
  return storedEnum(CANVAS_ENGINE_KEY, CANVAS_ENGINES, "current");
}

export function writeCanvasEngine(engine: CanvasEngine): void {
  writeStored(CANVAS_ENGINE_KEY, engine);
}
