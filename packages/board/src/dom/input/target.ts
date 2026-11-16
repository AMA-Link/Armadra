// 按下目标的缺省解析：DOM 属性约定，查不到再问 Canvas 对象，最后才是空白。
//   data-board-editable            输入框、终端、可选文本 → editable（引擎放手）
//   data-board-handle="<handle>"   resize / 连线把手，宿主是最近的 data-board-id
//   data-board-drag-handle         在 data-board-id 内 → 实体的 drag-handle 部位
//   data-board-id="<id>"           实体宿主 → body
import type { Vec } from "../../core";
import type { HitTarget, ResizeHandle, ConnectSide } from "../types";

export type ResolveTarget = (
  target: EventTarget | null,
  world: Vec,
) => HitTarget;

/** 应用补充的选择器：沿用别处已有的类名约定，免得到处加 data 属性。 */
export interface BoardSelectors {
  /** 与 `[data-board-editable]` 同义：命中就放手。 */
  editable?: string;
  /** 与 `[data-board-nowheel]` 同义：普通滚轮归它自己。 */
  nowheel?: string;
}

export const selectorOf = (base: string, extra?: string): string =>
  extra ? `${base},${extra}` : base;

export function createResolveTarget(
  hitCanvas?: (world: Vec) => HitTarget | undefined | null,
  selectors: BoardSelectors = {},
): ResolveTarget {
  const editable = selectorOf("[data-board-editable]", selectors.editable);
  return (target, world) => {
    const el = target instanceof Element ? target : null;
    if (el?.closest(editable)) return { type: "editable" };
    const idOf = (e: Element | null | undefined) =>
      e?.getAttribute("data-board-id");
    const handle = el?.closest("[data-board-handle]");
    const handleId = idOf(handle?.closest("[data-board-id]"));
    if (handle && handleId) {
      const name = handle.getAttribute("data-board-handle") as
        ResizeHandle | ConnectSide;
      return { type: "handle", id: handleId, handle: name };
    }
    const host = el?.closest("[data-board-id]");
    const id = idOf(host);
    if (host && id) {
      const grip = el?.closest("[data-board-drag-handle]");
      const part = grip && host.contains(grip) ? "drag-handle" : "body";
      return { type: "entity", id, part };
    }
    return hitCanvas?.(world) ?? { type: "blank" };
  };
}

/** 容器内坐标；矩形在连续事件间共用（每次重量都会强制结算样式与布局），隔 200 ms 重量。 */
export function createLocal(container: HTMLElement) {
  let rect: DOMRect | undefined;
  let at = 0;
  return (e: { clientX: number; clientY: number; timeStamp: number }): Vec => {
    if (!rect || e.timeStamp - at > 200)
      rect = container.getBoundingClientRect();
    at = e.timeStamp;
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
}
