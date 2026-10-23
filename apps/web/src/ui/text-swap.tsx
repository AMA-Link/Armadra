import * as React from "react";

import { cn } from "@/lib/cn";

/** 与 `--dur-fast` 同值：旧字淡出的时间，也是它留在 DOM 里的时间。 */
const SWAP_OUT_MS = 120;

/**
 * 文字替换（设计系统 §8.4）：旧字淡出 + 模糊 2px，新字反向淡入（延迟 40ms），
 * 容器宽度 `--dur-base` 平滑到新宽度。用于非用户直接输入的文字——状态、计数、
 * 「复制」→「已复制」、Dock 缩放百分比；成功反馈用它，不弹 toast。
 * 第一次渲染不播；减少动效下直接换。读屏只读新字（旧字 `aria-hidden`）。
 */
function TextSwap({
  children,
  className,
}: {
  children: string | number;
  className?: string;
}) {
  const text = String(children);
  const last = React.useRef(text);
  const [previous, setPrevious] = React.useState<string | null>(null);
  const [swapped, setSwapped] = React.useState(false);
  const [width, setWidth] = React.useState<number | undefined>(undefined);
  const current = React.useRef<HTMLSpanElement>(null);

  React.useEffect(() => {
    if (last.current === text) return;
    const old = last.current;
    last.current = text;
    setPrevious(old);
    setSwapped(true);
    const timer = setTimeout(() => setPrevious(null), SWAP_OUT_MS);
    return () => clearTimeout(timer);
  }, [text]);

  React.useLayoutEffect(() => {
    const measured = current.current?.offsetWidth ?? 0;
    if (measured > 0) setWidth(measured);
  }, [text]);

  return (
    <span
      data-slot="text-swap"
      data-swapping={previous === null ? undefined : "true"}
      style={width === undefined ? undefined : { width }}
      className={cn(
        "relative inline-flex overflow-hidden align-bottom whitespace-nowrap transition-[width] duration-(--dur-base) ease-(--ease-out)",
        className,
      )}
    >
      {previous !== null && (
        <span
          data-slot="text-swap-old"
          aria-hidden
          className="anim-swap-out absolute inset-y-0 left-0"
        >
          {previous}
        </span>
      )}
      <span
        key={text}
        ref={current}
        data-slot="text-swap-new"
        className={cn("inline-block", swapped && "anim-swap-in")}
      >
        {text}
      </span>
    </span>
  );
}

export { TextSwap };
