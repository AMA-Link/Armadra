// 手势与内置工具的共用依赖。Board 契约里读不到选项与种类表，由门面通过这里注入。
import type { Entity, EntityId, Rect, Vec } from "../../core";
import type { Clock } from "../camera";
import type {
  Board,
  BoardOptions,
  ConnectSide,
  DomKindSpec,
  Gesture,
  PointerInput,
} from "../types";

export interface GestureOptions extends Pick<
  BoardOptions,
  "grid" | "marqueeContain" | "dragThreshold" | "readOnly"
> {
  /** 拖动时指针靠近视口边缘自动平移。 */
  autoPan: boolean;
}

export const DEFAULT_GESTURE_OPTIONS: GestureOptions = {
  grid: 0,
  marqueeContain: false,
  dragThreshold: 4,
  readOnly: false,
  autoPan: true,
};

/** 手势进行中需要画出来的临时图形（框选框、拉线、起笔草稿），结束时收到 null。 */
export type GestureFeedback =
  | { type: "marquee"; rect: Rect }
  | {
      type: "connect";
      from: EntityId;
      side: ConnectSide;
      to: Vec;
      over: EntityId | null;
    }
  | { type: "draw"; tool: string; draft: unknown };

export interface GestureDeps {
  options?(): Partial<GestureOptions>;
  kind?(
    kind: string,
  ):
    | Pick<DomKindSpec, "layer" | "resize" | "connect" | "dragHandle">
    | undefined;
  /** 能否作为拖入的容器；缺省 `kind === "group"`。 */
  isContainer?(entity: Entity): boolean;
  feedback?(feedback: GestureFeedback | null): void;
  clock?: Clock;
}

export interface GestureCtx {
  board: Board;
  deps: GestureDeps;
}

export const optionsOf = (ctx: GestureCtx): GestureOptions => ({
  ...DEFAULT_GESTURE_OPTIONS,
  ...ctx.deps.options?.(),
});

export const snap = (value: number, grid: number): number =>
  grid > 0 ? Math.round(value / grid) * grid : value;

export const isTouchLike = (input: PointerInput): boolean =>
  input.type !== "mouse";

export type { Gesture };
