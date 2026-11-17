// 框选：空白处拖出矩形，边拖边发 select（选区变了才发，一次提交只带动少数节点重渲）。
// 没拖动的一下等于点空白（清空选区）。
import {
  marquee,
  rectFromPoints,
  vecDist,
  type HitSource,
  type SpatialIndex,
} from "../../core";
import type { Gesture, PointerInput } from "../types";
import { nextSelection, optionsOf, type GestureCtx } from "./types";

/** 场景（按包围盒相交查询）适配成 core `marquee` 要的命中源；连接类实体不参与。 */
const sourceOf = (ctx: GestureCtx): HitSource => {
  const { scene } = ctx.board;
  return {
    index: {
      queryRect: (rect) => scene.query(rect).map((e) => e.id),
      get: (id) => scene.bounds(id),
    } as SpatialIndex<string>,
    order: (id) => scene.get(id)?.z ?? 0,
    filter: (id) => !scene.get(id)?.ends,
  };
};

export function createMarquee(ctx: GestureCtx, first: PointerInput): Gesture {
  const { board, deps } = ctx;
  const o = optionsOf(ctx);
  const additive = first.mods.shift;
  const base = board.selection();
  let moved = false;
  let hit: string[] = [];
  let shown: string | null = null;
  const emit = () => {
    const ids = nextSelection(base, hit, additive);
    if (shown === ids.join()) return;
    shown = ids.join();
    board.emit("select", { ids, additive });
  };
  const update = (input: PointerInput) => {
    if (!moved && vecDist(input.screen, first.screen) < o.dragThreshold) return;
    moved = true;
    const rect = rectFromPoints(first.world, input.world);
    hit = marquee(
      sourceOf(ctx),
      rect,
      o.marqueeContain ? "contain" : "intersect",
    );
    deps.feedback?.({ type: "marquee", rect });
    emit();
  };
  return {
    name: "marquee",
    move: update,
    end(input) {
      update(input);
      deps.feedback?.(null);
      if (shown === null) emit();
    },
    cancel: () => deps.feedback?.(null),
  };
}
