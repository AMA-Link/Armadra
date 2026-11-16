// 绘图外壳：工具提供 start / extend / finish，外壳管指针、反馈与 create 事件。
import type { Gesture, PointerInput } from "../types";
import type { GestureCtx } from "./types";

export interface DrawHooks<T> {
  start(input: PointerInput): T;
  extend(draft: T, input: PointerInput): T;
  /** 收笔：返回 null 表示丢弃（例如没拖出长度）。 */
  finish(draft: T, input: PointerInput): T | null;
}

export function createDraw<T>(
  ctx: GestureCtx,
  first: PointerInput,
  tool: string,
  hooks: DrawHooks<T>,
): Gesture {
  const { board, deps } = ctx;
  let draft = hooks.start(first);
  const show = () => deps.feedback?.({ type: "draw", tool, draft });
  show();
  return {
    name: "draw",
    move(input) {
      draft = hooks.extend(draft, input);
      show();
    },
    end(input) {
      const done = hooks.finish(draft, input);
      deps.feedback?.(null);
      if (done !== null) board.emit("create", { tool, draft: done });
    },
    cancel: () => deps.feedback?.(null),
  };
}
