// 双指：平移 + 缩放。中点带着世界点走，两指间距决定缩放。
import { clampZoom } from "../../core";
import type { Gesture, PointerInput } from "../types";
import type { GestureCtx } from "./types";

interface Contact {
  id: number;
  x: number;
  y: number;
}

export function createPinch(
  ctx: GestureCtx,
  first: Contact,
  second: PointerInput,
): Gesture {
  const camera = ctx.board.camera;
  const points = new Map<number, Contact>([
    [first.id, first],
    [second.id, { id: second.id, ...second.screen }],
  ]);
  const read = () => {
    const [a, b] = [...points.values()] as [Contact, Contact];
    return {
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      dist: Math.hypot(a.x - b.x, a.y - b.y),
    };
  };
  let prev = read();
  return {
    name: "pinch",
    move(input) {
      if (!points.has(input.id)) return;
      points.set(input.id, { id: input.id, ...input.screen });
      const now = read();
      if (!camera.locked) {
        const state = camera.get();
        const zoom = clampZoom(
          prev.dist > 0 ? (state.zoom * now.dist) / prev.dist : state.zoom,
          camera.limits,
        );
        const world = camera.screenToWorld(prev.mid);
        camera.set({
          x: now.mid.x - world.x * zoom,
          y: now.mid.y - world.y * zoom,
          zoom,
        });
      }
      prev = now;
    },
    end() {},
    cancel() {},
  };
}
