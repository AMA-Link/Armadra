// 手势与内置工具的共用依赖。Board 契约里读不到选项与种类表，由门面通过这里注入。
import type { Entity, EntityId, Rect, Scene, Vec } from "../../core";
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

/** `id` 是否在 `ancestor` 之下（含自身）。 */
export function within(
  scene: Scene,
  id: EntityId,
  ancestor: EntityId,
): boolean {
  for (let at: EntityId | undefined = id; at; at = scene.get(at)?.parent) {
    if (at === ancestor) return true;
  }
  return false;
}

/** 去掉祖先也在集合里的实体：祖先带着它们走。 */
export const topLevel = (scene: Scene, ids: readonly EntityId[]): EntityId[] =>
  ids.filter((id) => {
    const parent = scene.get(id)?.parent;
    return !ids.some((o) => o !== id && parent && within(scene, parent, o));
  });

/** Shift 点选 / 框选后的最终选区：Shift 增减，否则取新的。 */
export const nextSelection = (
  current: ReadonlySet<EntityId>,
  hit: readonly EntityId[],
  additive: boolean,
): EntityId[] => {
  if (!additive) return [...hit];
  const out = new Set(current);
  for (const id of hit) {
    if (!out.delete(id)) out.add(id);
  }
  return [...out];
};
