// 内置工具。选择工具按设计 §2.6 的状态转移表分派手势。
import type { ConnectSide, Gesture, ResizeHandle, Tool } from "../types";
import { createConnect } from "./connect";
import { createDrag } from "./drag";
import { createMarquee } from "./marquee";
import { createPan } from "./pan";
import { createResize } from "./resize";
import type { GestureDeps } from "./types";
import { optionsOf } from "./types";

const SIDES: readonly string[] = ["top", "right", "bottom", "left"];

export function createSelectTool(deps: GestureDeps = {}): Tool {
  return {
    id: "select",
    cursor: "default",
    begin(input, board): Gesture | null {
      const ctx = { board, deps };
      const t = input.target;
      if (t.type === "editable") return null;
      if (input.button === 1 || (input.button === 0 && input.mods.space)) {
        return createPan(ctx, input);
      }
      if (input.button !== 0) return null;
      if (t.type === "blank") {
        return input.type === "touch"
          ? createPan(ctx, input)
          : createMarquee(ctx, input);
      }
      if (t.type === "handle") {
        if (optionsOf(ctx).readOnly) return null;
        return SIDES.includes(t.handle)
          ? createConnect(ctx, input, t.id, t.handle as ConnectSide)
          : createResize(ctx, input, t.id, t.handle as ResizeHandle);
      }
      const kind = board.scene.get(t.id)?.kind ?? "";
      const handleOnly = deps.kind?.(kind)?.dragHandle !== undefined;
      const movable =
        !optionsOf(ctx).readOnly && (t.part === "drag-handle" || !handleOnly);
      return createDrag(ctx, input, t.id, movable);
    },
  };
}

/** 手形：任何位置左 / 中键都平移，连输入区也不放过。 */
export function createHandTool(deps: GestureDeps = {}): Tool {
  return {
    id: "hand",
    cursor: "grab",
    begin: (input, board) =>
      input.button === 0 || input.button === 1
        ? createPan({ board, deps }, input)
        : null,
  };
}

export const selectTool: Tool = createSelectTool();
export const handTool: Tool = createHandTool();
