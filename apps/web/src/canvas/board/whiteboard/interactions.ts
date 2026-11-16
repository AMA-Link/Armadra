import type { CanvasNode } from "@armadra/shared";
import type { DomBoard } from "@armadra/board/dom";

import { usePreferencesStore } from "@/app/preferences-store";
import { isCanvasLocked } from "../../canvas-lock";
import { getTool } from "../../interaction/tool-store";
import { trackPointer } from "../../interaction/pointer";
import { isItemId, type Item } from "../../whiteboard/model";
import { snapToGrid } from "../../whiteboard/tools/grid";
import { createBoardText } from "./tools";
import { setEditing } from "./text-edit";

/**
 * `next` 下白板的指针交互：空白处双击新建文字、双击对象进编辑、触屏长按出菜单、
 * 「粘贴到光标处」的指针记录，以及右键落在 Canvas 对象上时给菜单找目标。
 */

type Board = DomBoard<CanvasNode>;

const TOLERANCE_PX = 4;

/** 右键 / 长按落在哪个白板对象上：置顶对象先于节点宿主，置底对象在宿主之下。 */
export function itemAtEvent(
  board: Board,
  event: { clientX: number; clientY: number; target: EventTarget | null },
  container: HTMLElement,
): string | null {
  const rect = container.getBoundingClientRect();
  const world = board.camera.screenToWorld({
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  });
  const tolerance = TOLERANCE_PX / board.camera.get().zoom;
  const pick = (layer: "canvas-over" | "canvas-under") => {
    const hit = board.scene.hit(world, { tolerance, layers: [layer] });
    return hit && isItemId(hit.id) ? hit.id : null;
  };
  const over = pick("canvas-over");
  if (over) return over;
  const target = event.target;
  if (target instanceof Element && target.closest("[data-board-id]")) {
    return null;
  }
  return pick("canvas-under");
}

/** 长按（触屏识别器发的 `context-menu`）没有原生 `contextmenu`：合成一次，让应用的菜单照常打开。 */
function bridgeLongPress(board: Board, container: HTMLElement): () => void {
  // 原生（鼠标 / Android 系统长按）的 contextmenu 会先经过这里的捕获监听：
  // 同一时刻引擎发的 `context-menu` 事件不再重复合成。
  let nativeAt = -Infinity;
  const mark = (event: Event) => {
    nativeAt = event.timeStamp;
  };
  container.addEventListener("contextmenu", mark, true);
  const stop = board.on("context-menu", ({ screen }) => {
    if (performance.now() - nativeAt < 100) return;
    const rect = container.getBoundingClientRect();
    const point = { x: rect.left + screen.x, y: rect.top + screen.y };
    const at = document.elementFromPoint(point.x, point.y) ?? container;
    at.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 2,
        clientX: point.x,
        clientY: point.y,
      }),
    );
  });
  return () => {
    stop();
    container.removeEventListener("contextmenu", mark, true);
  };
}

export function installWhiteboardInteractions(
  board: Board,
  container: HTMLElement,
  readOnly: () => boolean,
): () => void {
  const stops = [
    trackPointer(container),
    bridgeLongPress(board, container),
    board.on("double-click", ({ target, world }) => {
      if (isCanvasLocked() || readOnly()) return;
      if (target.type === "entity" && isItemId(target.id)) {
        const item = board.scene.get(target.id)?.data as unknown as
          Item | undefined;
        if (item?.kind === "text") {
          setEditing({ id: target.id, field: "text" });
        } else if (item?.kind === "shape") {
          setEditing({ id: target.id, field: "label" });
        }
        return;
      }
      // 空白处双击 = 新建文字并直接进编辑（只在选择工具下；绘图工具的双击是两笔）。
      if (target.type !== "blank" || getTool() !== "select") return;
      const { snap, gridSize } = usePreferencesStore.getState().whiteboard;
      createBoardText(snapToGrid(world, gridSize, snap));
    }),
  ];
  return () => stops.forEach((stop) => stop());
}
