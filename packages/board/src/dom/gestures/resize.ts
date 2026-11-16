// 缩放：8 把手。受 KindSpec.resize 约束（min / keepAspect / widthOnly），
// 过程写预览，结束发 resize（box 与实体同一坐标系：相对父级）。
import type { EntityId, Rect } from "../../core";
import type { Gesture, PointerInput, ResizeHandle } from "../types";
import { optionsOf, snap, type GestureCtx } from "./types";

const DEFAULT_MIN = { w: 24, h: 24 };

export function createResize(
  ctx: GestureCtx,
  first: PointerInput,
  id: EntityId,
  handle: ResizeHandle,
): Gesture | null {
  const { board, deps } = ctx;
  const { scene } = board;
  const entity = scene.get(id);
  const b = scene.bounds(id);
  const spec = entity && deps.kind?.(entity.kind)?.resize;
  if (!entity || !b || spec === false) return null;
  const min = spec?.min ?? DEFAULT_MIN;
  const widthOnly = spec?.widthOnly ?? false;
  const grid = optionsOf(ctx).grid;
  // 绝对坐标 → 实体自己的坐标系（相对父级）
  const off = { x: b.x - entity.x, y: b.y - entity.y };
  let moved = false;
  let box: Rect = { x: entity.x, y: entity.y, w: entity.w, h: entity.h };

  const compute = (input: PointerInput): Rect => {
    const dx = input.world.x - first.world.x;
    const dy = input.world.y - first.world.y;
    let [l, t, r, bt] = [b.x, b.y, b.x + b.w, b.y + b.h];
    if (handle.includes("w")) l = Math.min(snap(l + dx, grid), r - min.w);
    if (handle.includes("e")) r = Math.max(snap(r + dx, grid), l + min.w);
    if (!widthOnly && handle.includes("n"))
      t = Math.min(snap(t + dy, grid), bt - min.h);
    if (!widthOnly && handle.includes("s"))
      bt = Math.max(snap(bt + dy, grid), t + min.h);
    if ((spec?.keepAspect || input.mods.shift) && !widthOnly) {
      const sx = (r - l) / b.w;
      const sy = (bt - t) / b.h;
      const s = Math.max(
        handle.length === 2 ? Math.max(sx, sy) : /[ew]/.test(handle) ? sx : sy,
        min.w / b.w,
        min.h / b.h,
      );
      const [w, h] = [b.w * s, b.h * s];
      l = handle.includes("w")
        ? b.x + b.w - w
        : handle.includes("e")
          ? b.x
          : b.x + (b.w - w) / 2;
      t = handle.includes("n")
        ? b.y + b.h - h
        : handle.includes("s")
          ? b.y
          : b.y + (b.h - h) / 2;
      [r, bt] = [l + w, t + h];
    }
    return { x: l - off.x, y: t - off.y, w: r - l, h: bt - t };
  };
  const update = (input: PointerInput) => {
    moved = true;
    box = compute(input);
    scene.preview(new Map([[id, box]]));
  };
  return {
    name: "resize",
    move: update,
    end(input) {
      if (
        !moved &&
        input.screen.x === first.screen.x &&
        input.screen.y === first.screen.y
      )
        return;
      update(input);
      board.emit("resize", { id, box });
      scene.clearPreview([id]);
    },
    cancel: () => scene.clearPreview([id]),
  };
}
