// 画板引擎 core 的公共类型（docs/design/board-engine.md §2.3–§2.5）。
// 这里只放各模块共享的最小签名：没有实现、没有 DOM、没有 React。

export interface Vec {
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

/** 世界坐标下的轴对齐矩形：左上角加宽高。 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type EntityId = string;

/** 实体的种类决定它画在哪一层、怎么命中。 */
export type Layer = "canvas-under" | "world" | "canvas-over" | "overlay";

export interface Entity<D = unknown> {
  readonly id: EntityId;
  /** 应用自定义：`card` `group` `ink` `text` `shape` `image` `line` `link` `reference`。 */
  readonly kind: string;
  /** 父实体；坐标相对父。 */
  readonly parent?: EntityId;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** 同层内的绘制顺序。 */
  readonly z: number;
  /** 连接类实体（连线、引用）的两端；有它就没有自己的 x/y/w/h 语义。 */
  readonly ends?: readonly [EntityId, EntityId];
  /** 业务内容，引擎不看。 */
  readonly data: D;
}

/**
 * 绘制环境。资源位图的具体类型属于 DOM，core 不认识，所以用类型参数 `I` 留给 dom 入口收窄。
 */
export interface PaintEnv<I = unknown> {
  zoom: number;
  dpr: number;
  theme: "light" | "dark";
  /** 颜色名 → 十六进制。 */
  color(name: string): string;
  /** 资源位图；没到位返回 undefined 并在到位后请求重绘。 */
  image(key: string): I | undefined;
  selected: boolean;
}

/**
 * 每种 kind 的行为表，由应用注册。
 * `C` 是 2D 绘制上下文、`I` 是位图类型：core 的类型环境里没有 DOM，由 dom 入口
 * 分别收窄成 `CanvasRenderingContext2D` 与 `CanvasImageSource`。
 */
export interface KindSpec<D = unknown, C = unknown, I = unknown> {
  layer: Layer;
  /** 精确命中；缺省按包围盒。 */
  hit?(entity: Entity<D>, point: Vec, tolerance: number): boolean;
  /** 画到 Canvas（canvas-* 层必填；world 层用于缩略图与导出，可选）。 */
  paint?(ctx: C, entity: Entity<D>, env: PaintEnv<I>): void;
  /** 是否当连线障碍。 */
  obstacle?: boolean;
  resize?: { min: Size; keepAspect?: boolean; widthOnly?: boolean } | false;
  /** 拖拽起手区选择器（world 层）。 */
  dragHandle?: string;
  connect?: { start: boolean; end: boolean };
}
