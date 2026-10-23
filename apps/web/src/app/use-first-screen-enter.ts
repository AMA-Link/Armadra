import { useEffect, useState, useSyncExternalStore } from "react";

import {
  splashPhase,
  subscribeSplashPhase,
  type SplashPhase,
} from "../splash/session";

/**
 * 首屏错落入场的状态机（设计系统 §8.7）。
 *
 *  - `off`：平时的首帧——没放开屏、开屏早已退场、减少动效——什么都不播；
 *  - `wait`：开屏还在放，或刚开始淡出的头 `LEAD_MS`；侧栏 / 画布 / 工具三块先藏好；
 *  - `play`：三块依次入场（样式在 `first-screen.css`），播完回到 `off`。
 *
 * 开始淡出后 `LEAD_MS`（80ms）起播：让覆盖层先露出一点底色，三块再动，而不是
 * 与淡出同一拍。播放期间元素已可点、可聚焦（样式只动 opacity 与 translate）。
 */
export type FirstScreenEnter = "off" | "wait" | "play";

/** 淡出开始到入场起播。 */
export const FIRST_SCREEN_LEAD_MS = 80;
/** 三块之间的间隔（与 `first-screen.css` 的 `--first-step` 同值）。 */
export const FIRST_SCREEN_STEP_MS = 100;
/** `--dur-slow`：每块自己的时长。 */
const BLOCK_MS = 200;
/** 起播之后到摘掉 `data-enter` 的时间：最后一块的延迟 + 时长，再留一点余量。 */
export const FIRST_SCREEN_TOTAL_MS = FIRST_SCREEN_STEP_MS * 2 + BLOCK_MS + 40;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useFirstScreenEnter(): FirstScreenEnter {
  const phase = useSyncExternalStore<SplashPhase>(
    subscribeSplashPhase,
    splashPhase,
    () => "idle",
  );
  const [started, setStarted] = useState(false);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    if (started || (phase !== "leaving" && phase !== "done")) return;
    // 退场中才起播；`done` 但从没起播过（App 比开屏晚挂载）不补播
    if (phase === "done") return;
    const timer = window.setTimeout(
      () => setStarted(true),
      FIRST_SCREEN_LEAD_MS,
    );
    return () => window.clearTimeout(timer);
  }, [phase, started]);

  useEffect(() => {
    if (!started) return;
    const timer = window.setTimeout(
      () => setFinished(true),
      FIRST_SCREEN_TOTAL_MS,
    );
    return () => window.clearTimeout(timer);
  }, [started]);

  if (prefersReducedMotion() || finished) return "off";
  if (started) return "play";
  return phase === "playing" || phase === "leaving" ? "wait" : "off";
}
