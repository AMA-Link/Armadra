// 滚轮：ctrl / meta（含触控板捏合）与「鼠标」偏好下的滚轮缩放，其余平移。
// 可编辑或自滚区（data-board-editable / data-board-nowheel）里的普通滚轮放手；
// 缩放手势不看焦点，只看事件自己的修饰键（对应旧 wheel-zoom.ts）。
import { MAX_WHEEL_DELTA, wheelZoomFactor } from "../../core";
import type { Camera, InputDevice } from "../types";

const LINE = 16;
const PAGE = 400;

export function createWheelHandler(
  container: HTMLElement,
  camera: Camera,
  inputDevice: () => InputDevice,
) {
  const local = (e: { clientX: number; clientY: number }) => {
    const r = container.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  return (e: WheelEvent): void => {
    const zoom = e.ctrlKey || e.metaKey || inputDevice() === "mouse";
    const own =
      e.target instanceof Element &&
      e.target.closest("[data-board-editable],[data-board-nowheel]");
    if (own && !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    if (camera.locked) return;
    const unit = e.deltaMode === 1 ? LINE : e.deltaMode === 2 ? PAGE : 1;
    let dx = e.deltaX * unit;
    let dy = e.deltaY * unit;
    if (zoom) {
      const clamped = Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, dy));
      camera.zoomAround(local(e), camera.get().zoom * wheelZoomFactor(clamped));
      return;
    }
    if (e.shiftKey && dx === 0) [dx, dy] = [dy, 0];
    camera.panBy(-dx, -dy);
  };
}

/** Safari 的触控板捏合不发 wheel，发 gesture*；scale 相对手势开始时。 */
export function attachSafariGestures(
  container: HTMLElement,
  camera: Camera,
): () => void {
  type G = Event & { scale: number; clientX: number; clientY: number };
  let base = 1;
  const on = (name: string, fn: (e: G) => void) => {
    const listener = (e: Event) => {
      e.preventDefault();
      fn(e as G);
    };
    container.addEventListener(name, listener);
    return () => container.removeEventListener(name, listener);
  };
  const offs = [
    on("gesturestart", () => void (base = camera.get().zoom)),
    on("gesturechange", (e) => {
      if (camera.locked) return;
      const r = container.getBoundingClientRect();
      camera.zoomAround(
        { x: e.clientX - r.left, y: e.clientY - r.top },
        base * e.scale,
      );
    }),
  ];
  return () => offs.forEach((off) => off());
}
