import * as React from "react";
import type { OnResize, OnResizeEnd, OnResizeStart } from "@xyflow/react";

/**
 * `NodeResizer` 的三个回调，**身份在节点的整个生命周期里不变**（#819 手指拉伸）。
 *
 * React Flow 的 `ResizeControl` 把这三个回调写进 effect 的依赖：身份一换，
 * 它就 `destroy()` 掉把手上的 d3-drag（`selection.on(".drag", null)`）再新绑
 * 一份。鼠标不受影响——d3-drag 把 `mousemove` / `mouseup` 挂在 `window` 上，
 * 旧手势照样收得到；**触摸**不一样，`touchmove` / `touchend` 挂在把手元素
 * 自己身上，换绑之后归了一个没有这次手势的新实例：
 *
 *  1. 第一帧 `onResize` 写了草稿，投影换掉节点、节点重渲、回调换了身份；
 *  2. 换绑之后的 `touchmove` 没有手势可接，节点停在第一帧的尺寸；
 *  3. `touchend` 也没人接，`onResizeEnd` 永远不来：尺寸不提交（别的设备看
 *     不到），草稿也不清——`hasDrafts()` 一直为真，实时绑定与远端合并都在
 *     「等手势结束」，这台设备从此收不到别人的任何改动，直到刷新。
 *
 * 所以三个回调都转发到 ref 里最新的那一份，交给 `NodeResizer` 的永远是
 * 第一次渲染造出来的那三个函数。
 */
export interface ResizeHandlers {
  onResizeStart?: OnResizeStart;
  onResize?: OnResize;
  onResizeEnd?: OnResizeEnd;
}

export function useStableResizeHandlers(
  handlers: ResizeHandlers,
): Required<ResizeHandlers> {
  const latest = React.useRef(handlers);
  // 回调只在指针事件里被调，那时这一轮渲染早已提交；布局 effect 里换就够了。
  React.useLayoutEffect(() => {
    latest.current = handlers;
  });
  return React.useMemo(
    () => ({
      onResizeStart: (event, params) =>
        latest.current.onResizeStart?.(event, params),
      onResize: (event, params) => latest.current.onResize?.(event, params),
      onResizeEnd: (event, params) =>
        latest.current.onResizeEnd?.(event, params),
    }),
    [],
  );
}
