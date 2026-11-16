import * as React from "react";

/**
 * 画布舞台的视口（与引擎无关）：平移、缩放与容器像素尺寸。
 *
 * 两种引擎各自把自己的相机推进来——旧引擎由 `FlowStagePublisher`（读 React Flow
 * 的 store）、自研引擎由 `BoardWorkspace`（读 `board.camera`）——外面的 Dock 缩放档位、
 * 浏览器节点的屏幕尺寸、成员光标、评论钉、实时视口广播都只认这一份，不再各自
 * 依赖某个引擎的 hook。画布没挂载时是 `{0, 0, 1}` 与 0 尺寸（与 React Flow 的缺省一致）。
 */
export interface StageView {
  x: number;
  y: number;
  zoom: number;
  width: number;
  height: number;
}

const IDLE: StageView = { x: 0, y: 0, zoom: 1, width: 0, height: 0 };

let view: StageView = IDLE;
const listeners = new Set<() => void>();

export function publishStageView(next: StageView | null): void {
  const value = next ?? IDLE;
  if (
    value.x === view.x &&
    value.y === view.y &&
    value.zoom === view.zoom &&
    value.width === view.width &&
    value.height === view.height
  ) {
    return;
  }
  view = value;
  for (const listener of [...listeners]) listener();
}

export function getStageView(): StageView {
  return view;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStageView(): StageView {
  return React.useSyncExternalStore(subscribe, getStageView, () => IDLE);
}

/**
 * 只关心缩放的订阅者用这个：平移时快照（一个数）不变，组件不重渲。
 * `useStageView()` 每次平移都换对象，Dock 这类只读档位的组件会跟着每一步重渲。
 */
export function useStageZoom(): number {
  return React.useSyncExternalStore(
    subscribe,
    () => view.zoom,
    () => IDLE.zoom,
  );
}

/** 档位读数的刷新间隔：连续缩放时数字每这么久才换一次。 */
export const ZOOM_READOUT_MS = 100;

/**
 * 只用来**显示**缩放档位的订阅（Dock 的百分比）：首次变化立即更新，连续变化
 * 之间最多每 `ZOOM_READOUT_MS` 换一次，停手后落到最终值。
 *
 * 一次滚轮缩放每一步都发相机事件；读数每步都重渲 Dock、还让 `TextSwap` 量一次宽度
 * （强制同步布局）并起一段淡入淡出，人眼读不出来，主线程却被占满。位置要和
 * 世界层对得上的订阅者（成员光标、评论钉、浏览器节点）不走这条，仍读实时值。
 */
export function useStageZoomReadout(): number {
  const [zoom, setZoom] = React.useState(() => view.zoom);
  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let shown = view.zoom;
    const flush = () => {
      timer = null;
      if (view.zoom === shown) return;
      shown = view.zoom;
      setZoom(shown);
    };
    flush();
    const stop = subscribe(() => {
      if (timer !== null) return;
      flush();
      timer = setTimeout(flush, ZOOM_READOUT_MS);
    });
    return () => {
      stop();
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
  return zoom;
}
