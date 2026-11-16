// 平移：屏幕增量直接加到相机上；第二根手指切到 pinch。
import type { Gesture, PointerInput } from "../types";
import { createPinch } from "./pinch";
import type { GestureCtx } from "./types";

export function createPan(ctx: GestureCtx, first: PointerInput): Gesture {
  let last = { id: first.id, x: first.screen.x, y: first.screen.y };
  return {
    name: "pan",
    move(input) {
      if (input.id !== last.id) return;
      const { camera } = ctx.board;
      if (!camera.locked) {
        camera.panBy(input.screen.x - last.x, input.screen.y - last.y);
      }
      last = { id: input.id, ...input.screen };
    },
    add: (second) => createPinch(ctx, last, second),
    end() {},
    cancel() {},
  };
}
