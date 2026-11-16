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

export function createResolveTarget(
  hitCanvas?: (world: Vec) => HitTarget | undefined | null,
): ResolveTarget {
  return (target, world) => {
    const el = target instanceof Element ? target : null;
    if (el?.closest("[data-board-editable]")) return { type: "editable" };
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
