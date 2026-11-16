// 触屏识别器（对齐 interaction/touch-create.ts）：长按 → context-menu，
// 双击 → double-click。不合成 contextmenu 事件。只看触摸与笔。
import type { HitTarget, PointerInput } from "../types";

export const LONG_PRESS_MS = 500;
export const TAP_SLOP_PX = 10;
export const TAP_MAX_MS = 250;
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_DISTANCE_PX = 30;
/** 识别器触发之后这么久里原生的 contextmenu / dblclick / click 算同一下。 */
export const ECHO_WINDOW_MS = 800;

export interface TouchRecognizer {
  down(input: PointerInput): void;
  move(input: PointerInput): void;
  up(input: PointerInput): void;
  /** 多指或手势被取消：放弃等待中的识别。 */
  reset(): void;
  /** 最近一次触发的时间（毫秒，`input.time` 同一时钟）；0 = 没触发过。 */
  readonly firedAt: number;
}

export interface TouchRecognizerHooks {
  /** 返回 false 表示这里不接管（如输入区）。 */
  longPress(input: PointerInput): boolean;
  doubleTap(input: PointerInput): void;
}

const dist = (a: PointerInput, b: PointerInput) =>
  Math.hypot(a.screen.x - b.screen.x, a.screen.y - b.screen.y);

export function createTouchRecognizer(
  hooks: TouchRecognizerHooks,
): TouchRecognizer {
  let press: PointerInput | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previous: PointerInput | null = null;
  let fired = 0;
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
    press = null;
  };
  const editable = (t: HitTarget) => t.type === "editable";
  return {
    get firedAt() {
      return fired;
    },
    down(input) {
      if (input.type === "mouse" || press) return clear();
      if (editable(input.target)) return;
      press = input;
      timer = setTimeout(() => {
        const at = press;
        clear();
        if (at && hooks.longPress(at)) fired = at.time + LONG_PRESS_MS;
      }, LONG_PRESS_MS);
    },
    move(input) {
      if (press && dist(input, press) > TAP_SLOP_PX) clear();
    },
    up(input) {
      const at = press;
      if (!at || at.id !== input.id) return;
      clear();
      if (input.time - at.time > TAP_MAX_MS || dist(input, at) > TAP_SLOP_PX)
        return;
      if (
        previous &&
        at.time - previous.time <= DOUBLE_TAP_MS &&
        dist(at, previous) <= DOUBLE_TAP_DISTANCE_PX
      ) {
        previous = null;
        fired = input.time;
        hooks.doubleTap(at);
      } else previous = at;
    },
    reset() {
      clear();
      previous = null;
    },
  };
}
