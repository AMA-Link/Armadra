/**
 * `motion` 库侧的动效常量（设计系统 §8.2）：与 `styles/tokens.css` 的令牌同值，
 * `ui/ui.test.tsx` 逐条核对。CSS 里用令牌，只有 JS 驱动的动画（指示器、布局动画、
 * 图标切换、数字）才读这里；没有回弹，bounce 永远是 0。
 */

/** 一切进场与退场、按下：`--ease-out`。 */
export const EASE_OUT = [0.23, 1, 0.32, 1] as const;
/** 已在屏上的元素移动 / 变形：`--ease-in-out`。 */
export const EASE_IN_OUT = [0.77, 0, 0.175, 1] as const;
/** Sheet、抽屉、设置子页与手机页面推入：`--ease-drawer`。 */
export const EASE_DRAWER = [0.32, 0.72, 0, 1] as const;

/** 秒；与 `--dur-*` 同值。 */
export const DURATION = {
  instant: 0.1,
  fast: 0.12,
  base: 0.16,
  slow: 0.2,
  page: 0.28,
  hero: 0.6,
} as const;

/** `MotionConfig` 的默认过渡。 */
export const MOTION_TRANSITION = {
  duration: DURATION.base,
  ease: EASE_OUT,
} as const;

/** `motion` 库里唯一的弹簧：指示器、布局动画、图标切换。 */
export const MOTION_SPRING = {
  type: "spring",
  duration: 0.3,
  bounce: 0,
} as const;

/** 指示器平移：`--dur-base` `--ease-in-out`。 */
export const INDICATOR_TRANSITION = {
  duration: DURATION.base,
  ease: EASE_IN_OUT,
} as const;

/**
 * 过界拖动的阻力（设计系统 §8.3）：拖得越远越难拖，渐近 `limit`，不做硬停。
 * `distance` 是越过边界的像素数，返回应当显示的位移。
 */
export function rubberBand(distance: number, limit = 120): number {
  if (distance <= 0) return 0;
  return (1 - 1 / ((distance * 0.55) / limit + 1)) * limit;
}
