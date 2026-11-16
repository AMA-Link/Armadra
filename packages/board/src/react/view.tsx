// 视图：挂载板、提供 context，叠加层插槽用 portal 进引擎的叠加层。
import * as React from "react";
import { createPortal } from "react-dom";
import type { DomBoard } from "../dom";
import { BoardProvider, useBoard } from "./context";

export interface BoardViewProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "children"
> {
  board: DomBoard;
  /**
   * 只放 `EntityHosts`、`Overlay`、`WorldOverlay` 这类走 portal 的东西：
   * 引擎独占容器里的 DOM，普通元素会成为容器的兄弟。
   */
  children?: React.ReactNode;
}

export function BoardView({ board, children, ...rest }: BoardViewProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = React.useState(false);
  // 布局阶段挂载：宿主在首次绘制前就位，子树才能立刻 portal 进去。
  React.useLayoutEffect(() => {
    const container = ref.current;
    if (!container) return;
    board.mount(container);
    setMounted(true);
    return () => {
      setMounted(false);
      board.unmount();
    };
  }, [board]);
  return (
    <BoardProvider value={board}>
      <div ref={ref} {...rest} />
      {mounted ? children : null}
    </BoardProvider>
  );
}

export interface WorldOverlayProps {
  children?: React.ReactNode;
  /** `svg`：连线、预览线（世界坐标 SVG）；缺省是世界坐标的 HTML 层。 */
  layer?: "html" | "svg";
}

/** 世界坐标插槽：跟相机一起平移缩放，默认不接指针事件。 */
export function WorldOverlay({ children, layer = "html" }: WorldOverlayProps) {
  const slots = useBoard().slots();
  if (!slots) return null;
  return createPortal(
    children,
    layer === "svg" ? slots.worldSvg : slots.worldHtml,
  );
}

/** 屏幕坐标插槽：选框、把手、光标、评论钉；里面要交互的元素自己打开指针事件。 */
export function Overlay({ children }: { children?: React.ReactNode }) {
  const slots = useBoard().slots();
  return slots ? createPortal(children, slots.screen) : null;
}
