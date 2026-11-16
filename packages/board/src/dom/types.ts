// dom 入口的公共契约（docs/design/board-engine.md §2.5–§2.7）。
// B2 的输入 / 手势与渲染两条线都只依赖这里，互不 import 对方的实现。

import type {
  CameraState,
  EntityId,
  KindSpec,
  MemoryScene,
  PaintEnv,
  Rect,
  Vec,
} from "../core";

/* --------------------------------- 相机 ----------------------------------- */

export interface CameraOptions {
  duration?: number;
}

/** 有状态相机：core 的相机纯函数之上加订阅、锁定与动画。 */
export interface Camera {
  get(): CameraState;
  set(next: CameraState, options?: CameraOptions): void;
  /** 视口（容器）尺寸；挂载与容器尺寸变化时由 Board 写入。 */
  setViewport(size: { width: number; height: number }): void;
  screenToWorld(point: Vec): Vec;
  worldToScreen(point: Vec): Vec;
  /** 当前可见的世界矩形。 */
  visible(): Rect;
  panBy(dx: number, dy: number): void;
  zoomAround(screen: Vec, zoom: number, options?: CameraOptions): void;
  fit(
    bounds: Rect,
    options?: { padding?: number; maxZoom?: number } & CameraOptions,
  ): void;
  center(world: Vec, options?: { zoom?: number } & CameraOptions): void;
  subscribe(listener: (state: CameraState) => void): () => void;
  /** 锁定后用户手势不再移动相机；程序调用 `set` 仍然生效。 */
  locked: boolean;
  limits: { min: number; max: number };
}

/* --------------------------------- 输入 ----------------------------------- */

export type ResizeHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export type ConnectSide = "top" | "right" | "bottom" | "left";

export interface Modifiers {
  shift: boolean;
  alt: boolean;
  meta: boolean;
  ctrl: boolean;
  space: boolean;
}

export type HitTarget =
  | { type: "blank" }
  | { type: "entity"; id: EntityId; part: "body" | "drag-handle" }
  | { type: "handle"; id: EntityId; handle: ResizeHandle | ConnectSide }
  /** 输入框、终端、可选中文本：引擎放手。 */
  | { type: "editable" };

export interface PointerInput {
  id: number;
  type: "mouse" | "touch" | "pen";
  button: number;
  screen: Vec;
  world: Vec;
  pressure: number;
  mods: Modifiers;
  /** 按下那一刻命中的东西（overlay → world DOM → canvas 对象 → 连线 → 空白）。 */
  target: HitTarget;
  /** 毫秒时间戳（识别器算长按 / 双击用）。 */
  time: number;
}

export interface Gesture {
  readonly name: string;
  move(input: PointerInput): void;
  /** 第二根手指按下等情况；返回要切换到的手势。 */
  add?(input: PointerInput): Gesture | null;
  end(input: PointerInput): void;
  cancel(): void;
}

export interface Tool {
  /** select / hand / ink / shape / line / text …… */
  readonly id: string;
  cursor?: string;
  /** 按下时决定进入哪个手势；null = 不处理，交给浏览器。 */
  begin(input: PointerInput, board: Board): Gesture | null;
}

/* --------------------------------- 板 ------------------------------------- */

export type InputDevice = "mouse" | "trackpad";

export interface BoardOptions {
  /** 吸附网格边长（世界单位），0 = 不吸附。 */
  grid: number;
  /** 框选是否要求完全包含。 */
  marqueeContain: boolean;
  inputDevice: InputDevice;
  readOnly: boolean;
  /** 背景点阵。 */
  dots: boolean;
  /** 开始拖动的像素阈值。 */
  dragThreshold: number;
  theme: "light" | "dark";
}

export interface RasterOptions {
  scale?: number;
  padding?: number;
  background?: string | null;
}

/** dom 入口收窄后的种类行为：绘制上下文与位图是真实的 DOM 类型。 */
export type DomKindSpec<D = unknown> = KindSpec<
  D,
  CanvasRenderingContext2D,
  CanvasImageSource
>;
export type DomPaintEnv = PaintEnv<CanvasImageSource>;

export interface BoardEvents {
  move: {
    ids: EntityId[];
    positions: Map<EntityId, Vec>;
    reparent: Map<EntityId, EntityId | null>;
  };
  resize: { id: EntityId; box: Rect };
  connect: { from: EntityId; side: ConnectSide; to: EntityId | null; at: Vec };
  select: { ids: EntityId[]; additive: boolean };
  create: { tool: string; draft: unknown };
  "context-menu": { target: HitTarget; screen: Vec; world: Vec };
  "double-click": { target: HitTarget; world: Vec };
  camera: CameraState;
  gesture: { active: boolean };
  /** 世界层宿主增减（React 绑定据此增删 portal）。 */
  hosts: { added: EntityId[]; removed: EntityId[] };
  /** 选区变化（含程序设置）；`select` 才是用户意图。 */
  selection: { ids: EntityId[] };
}

export interface Board<D = unknown> {
  readonly camera: Camera;
  readonly scene: MemoryScene<D>;
  mount(container: HTMLElement): void;
  destroy(): void;
  registerKind(kind: string, spec: DomKindSpec<D>): void;
  setTool(tool: Tool): void;
  setOptions(options: Partial<BoardOptions>): void;
  setModifiers(mods: Partial<Modifiers>): void;
  selection(): ReadonlySet<EntityId>;
  setSelection(ids: ReadonlySet<EntityId>): void;
  gestureActive(): boolean;
  /** 世界层里这个实体的宿主元素；React 绑定往里 createPortal。 */
  hostOf(id: EntityId): HTMLElement | undefined;
  /** 把一组实体画到离屏 Canvas（PNG 导出、缩略图）。 */
  rasterize(ids: readonly EntityId[], options?: RasterOptions): Promise<Blob>;
  /** 手势内部发事件；应用订阅。 */
  emit<E extends keyof BoardEvents>(event: E, payload: BoardEvents[E]): void;
  on<E extends keyof BoardEvents>(
    event: E,
    listener: (payload: BoardEvents[E]) => void,
  ): () => void;
}
