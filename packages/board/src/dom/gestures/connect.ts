// 从连线把手拉线：落在别的实体上发 connect(to: id)，落在空白发 to: null。
import { vecDist, type EntityId } from "../../core";
import type { ConnectSide, Gesture, PointerInput } from "../types";
import { optionsOf, type GestureCtx } from "./types";

export function createConnect(
  ctx: GestureCtx,
  first: PointerInput,
  from: EntityId,
  side: ConnectSide,
): Gesture | null {
  const { board, deps } = ctx;
  if (deps.kind?.(board.scene.get(from)?.kind ?? "")?.connect?.start === false)
    return null;
  const threshold = optionsOf(ctx).dragThreshold;
  let started = false;
  let over: EntityId | null = null;

  const update = (input: PointerInput) => {
    if (!started && vecDist(input.screen, first.screen) < threshold) return;
    started = true;
    const { x, y } = input.world;
    over =
      board.scene
        .query(
          { x, y, w: 0, h: 0 },
          (e) =>
            e.id !== from &&
            !e.ends &&
            deps.kind?.(e.kind)?.connect?.end !== false,
        )
        .at(-1)?.id ?? null;
    deps.feedback?.({ type: "connect", from, side, to: input.world, over });
  };
  return {
    name: "connect",
    move: update,
    end(input) {
      update(input);
      deps.feedback?.(null);
      if (started)
        board.emit("connect", { from, side, to: over, at: input.world });
    },
    cancel: () => deps.feedback?.(null),
  };
}
