import * as React from "react";

/** 加载不到这么久就不画骨架（设计系统 §5.16）。 */
export const SKELETON_DELAY_MS = 200;
/** 骨架一旦画出来，至少停这么久再让位，免得一闪而过。 */
export const SKELETON_MIN_VISIBLE_MS = 300;

/**
 * - `idle`：没在等，直接渲染内容（有缓存的刷新也走这里，不出骨架）；
 * - `hold`：在等但还没到 `delay`——骨架要占着位置（不可见），内容到了不会推挤布局；
 * - `show`：骨架可见。
 */
export type SkeletonPhase = "idle" | "hold" | "show";

/**
 * 把「正在等首批数据」翻成骨架该处的阶段。`loading` 只在**没有可展示的数据**时才应为真
 * （有缓存先显示缓存，刷新不出骨架）。
 */
export function useSkeletonPhase(
  loading: boolean,
  options: { delay?: number; minVisible?: number } = {},
): SkeletonPhase {
  const delay = options.delay ?? SKELETON_DELAY_MS;
  const minVisible = options.minVisible ?? SKELETON_MIN_VISIBLE_MS;
  const [visible, setVisible] = React.useState(false);
  const shownAt = React.useRef(0);

  React.useEffect(() => {
    if (loading) {
      if (visible) return;
      const timer = setTimeout(() => {
        shownAt.current = Date.now();
        setVisible(true);
      }, delay);
      return () => clearTimeout(timer);
    }
    if (!visible) return;
    const wait = Math.max(0, minVisible - (Date.now() - shownAt.current));
    if (wait === 0) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(false), wait);
    return () => clearTimeout(timer);
  }, [loading, visible, delay, minVisible]);

  if (visible) return "show";
  return loading ? "hold" : "idle";
}
