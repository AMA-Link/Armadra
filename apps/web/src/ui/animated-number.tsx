import { useEffect, useRef, useState } from "react";
import { animate, useMotionValue, useReducedMotion } from "motion/react";

import { cn } from "@/lib/cn";
import { EASE_OUT } from "@/ui/motion";

/** 数字滚动的时长：400ms（设计系统 §8.4）。 */
const ROLL_SECONDS = 0.4;

/**
 * 数字之间补间（设计系统 §8.4）：400ms `--ease-out` 从旧值滚到新值，等宽数字。
 * 切范围、选中某天时数字跟着图表一起走，不硬跳；减少动效直接跳。
 *
 * 首次挂载默认直接显示目标值——入场已经有淡入了，数字再爬一遍是噪音；KPI 托盘 /
 * 用量环这类「首次出现」的值传 `fromZero`，从 0 填到当前值。
 * `unit` 变了也直接跳：从几百亿 token 补间到几千美元没有意义，而补间起步前那几帧会把
 * 旧的 token 数按美元格式显示出来。计时不要用它。
 * 非有限值（NaN / ±Infinity）不补间，交给 `format` 决定怎么显示（约定显示 `—`）。
 */
export function AnimatedNumber({
  value,
  format,
  unit,
  fromZero = false,
  className,
}: {
  value: number;
  format: (value: number) => string;
  unit?: string;
  fromZero?: boolean;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const motionValue = useMotionValue(fromZero ? 0 : value);
  const [display, setDisplay] = useState(fromZero ? 0 : value);
  const mounted = useRef(false);
  const lastUnit = useRef(unit);

  useEffect(() => {
    const first = !mounted.current;
    mounted.current = true;
    if (first && !fromZero) return;
    const unitChanged = lastUnit.current !== unit;
    lastUnit.current = unit;
    if (reduced || unitChanged || !Number.isFinite(value)) {
      motionValue.set(value);
      setDisplay(value);
      return;
    }
    const controls = animate(motionValue, value, {
      duration: ROLL_SECONDS,
      ease: EASE_OUT,
      onUpdate: (latest) => setDisplay(latest),
    });
    return () => controls.stop();
    // 首次出现只在挂载时由 fromZero 触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [motionValue, reduced, unit, value]);

  // 换单位的那一次渲染先于 effect：这一帧就得按新值显示，否则旧数字会穿上新格式。
  const shown = lastUnit.current !== unit ? value : display;
  return (
    <span data-numeric className={cn("tabular-nums", className)}>
      {format(shown)}
    </span>
  );
}
