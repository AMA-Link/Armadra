import * as React from "react";
import { ArrowDown } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { useT } from "@/app/preferences-store";
import { cn } from "@/lib/cn";
import { Button } from "@/ui/button";

/** 距底部不超过这个距离算「贴底」，新内容进来时跟随。 */
export const FOLLOW_DISTANCE_PX = 24;
/** 距顶部不超过这个距离就请求更早的回合。 */
export const NEAR_TOP_PX = 800;
const ESTIMATE_PX = 180;

export interface VirtualTurnListProps<T> {
  turns: readonly T[];
  getKey: (turn: T) => string | number;
  renderTurn: (turn: T) => React.ReactNode;
  overscan?: number | undefined;
  estimateSize?: number | undefined;
  /** 滚到离顶部这么近就调 `onNearTop`，默认 {@link NEAR_TOP_PX}。 */
  nearTopPx?: number | undefined;
  onNearTop?: (() => void) | undefined;
  /** 换会话时变，列表回到底部并重新跟随。 */
  resetKey?: string | undefined;
  /** 首次布局前的视口尺寸（测试与服务端渲染用）。 */
  initialRect?: { width: number; height: number } | undefined;
  className?: string | undefined;
  "aria-label"?: string | undefined;
}

/**
 * 按回合虚拟化的列表（设计 §4）：DOM 里只有可视回合加 overscan；ResizeObserver
 * 量高；贴底跟随，离开底部就保持阅读位置并出现「回到底部」；前面补进更早的
 * 回合时做锚点补偿，不跳屏。
 */
export function VirtualTurnList<T>({
  turns,
  getKey,
  renderTurn,
  overscan = 3,
  estimateSize = ESTIMATE_PX,
  nearTopPx = NEAR_TOP_PX,
  onNearTop,
  resetKey,
  initialRect,
  className,
  "aria-label": ariaLabel,
}: VirtualTurnListProps<T>) {
  const t = useT();
  const scroller = React.useRef<HTMLDivElement>(null);
  const following = React.useRef(true);
  const [away, setAway] = React.useState(false);

  const virtualizer = useVirtualizer({
    count: turns.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => estimateSize,
    overscan,
    getItemKey: (index) => {
      const turn = turns[index];
      return turn === undefined ? index : getKey(turn);
    },
    ...(initialRect !== undefined ? { initialRect } : {}),
  });
  const total = virtualizer.getTotalSize();

  // 贴底跟随：内容增高（流式、量高）时，贴着底的继续贴着。
  React.useLayoutEffect(() => {
    const element = scroller.current;
    if (element !== null && following.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [total, turns.length]);

  // 换会话：回到底部。
  React.useLayoutEffect(() => {
    following.current = true;
    setAway(false);
    const element = scroller.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [resetKey]);

  // 前面补进更早的回合：把原来的第一个回合钉回原来的位置。
  const firstKey = turns.length > 0 ? getKey(turns[0] as T) : null;
  const previousFirst = React.useRef<{
    key: string | number | null;
    top: number;
  }>({ key: firstKey, top: 0 });
  React.useLayoutEffect(() => {
    const before = previousFirst.current;
    const element = scroller.current;
    if (element !== null && before.key !== null && before.key !== firstKey) {
      const index = turns.findIndex((turn) => getKey(turn) === before.key);
      if (index > 0) {
        const start = virtualizer.measurementsCache[index]?.start ?? 0;
        virtualizer.scrollToOffset(before.top + start);
      }
    }
    previousFirst.current = { key: firstKey, top: element?.scrollTop ?? 0 };
  }, [firstKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const armed = React.useRef(true);
  const onScroll = (): void => {
    const element = scroller.current;
    if (element === null) return;
    const distance =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    const near = distance <= FOLLOW_DISTANCE_PX;
    following.current = near;
    setAway((current) => (current === !near ? current : !near));
    previousFirst.current.top = element.scrollTop;
    if (element.scrollTop <= nearTopPx) {
      if (armed.current) {
        armed.current = false;
        onNearTop?.();
      }
    } else {
      armed.current = true;
    }
  };
  // 补进了更早的回合之后，允许再次触发。
  React.useEffect(() => {
    armed.current = true;
  }, [firstKey]);

  const toBottom = (): void => {
    const element = scroller.current;
    if (element === null) return;
    following.current = true;
    element.scrollTop = element.scrollHeight;
    setAway(false);
  };

  return (
    <div className={cn("relative min-h-0 flex-1", className)}>
      <div
        ref={scroller}
        onScroll={onScroll}
        data-slot="timeline-scroller"
        role="log"
        aria-live="off"
        aria-label={ariaLabel}
        className="size-full overflow-y-auto"
      >
        <div className="relative w-full" style={{ height: total }}>
          {virtualizer.getVirtualItems().map((row) => {
            const turn = turns[row.index];
            if (turn === undefined) return null;
            return (
              <div
                key={row.key}
                ref={virtualizer.measureElement}
                data-index={row.index}
                data-slot="timeline-turn-row"
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${row.start}px)` }}
              >
                {renderTurn(turn)}
              </div>
            );
          })}
        </div>
      </div>
      {away && (
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={t("timeline.toBottom")}
          data-slot="timeline-to-bottom"
          className="absolute right-3 bottom-3 rounded-full shadow-sm"
          onClick={toBottom}
        >
          <ArrowDown />
        </Button>
      )}
    </div>
  );
}
