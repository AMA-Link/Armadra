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

/** 最近一次按下是不是触屏 / 笔：触屏双击等于「在那一点右键」，鼠标双击才是新建文字。 */
interface TouchMenu {
  stop(): void;
  isTouch(): boolean;
}

/**
 * 触屏没有原生 `contextmenu`（iOS 长按不发）：长按与空白处双击都合成一次，
 * 让应用的菜单照常打开，目标与落点按手指处解析（与旧画布的 `touch-create` 同一行为）。
 */
function bridgeTouchMenu(board: Board, container: HTMLElement): TouchMenu {
  // 原生（鼠标 / Android 系统长按）的 contextmenu 会先经过这里的捕获监听：
  // 同一时刻引擎发的 `context-menu` 事件不再重复合成。
  let nativeAt = -Infinity;
  let touch = false;
  const mark = (event: Event) => {
    nativeAt = event.timeStamp;
  };
  const track = (event: PointerEvent) => {
    touch = event.pointerType !== "mouse";
  };
  container.addEventListener("contextmenu", mark, true);
  container.addEventListener("pointerdown", track, true);
  const open = (screen: { x: number; y: number }) => {
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
  };
  const stops = [
    board.on("context-menu", ({ screen }) => {
      if (performance.now() - nativeAt < 100) return;
      open(screen);
    }),
    board.on("double-click", ({ target, world }) => {
      if (!touch || target.type !== "blank" || isCanvasLocked()) return;
      open(board.camera.worldToScreen(world));
    }),
  ];
  return {
    isTouch: () => touch,
    stop() {
      for (const stop of stops) stop();
      container.removeEventListener("contextmenu", mark, true);
      container.removeEventListener("pointerdown", track, true);
    },
  };
}

export function installWhiteboardInteractions(
  board: Board,
  container: HTMLElement,
  readOnly: () => boolean,
): () => void {
  const menu = bridgeTouchMenu(board, container);
  const stops = [
    trackPointer(container),
    menu.stop,
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
      // 触屏上同一下是「在这一点右键」，已由 `bridgeTouchMenu` 出新建菜单。
      if (target.type !== "blank" || getTool() !== "select") return;
      if (menu.isTouch()) return;
      const { snap, gridSize } = usePreferencesStore.getState().whiteboard;
      createBoardText(snapToGrid(world, gridSize, snap));
    }),
  ];
  return () => stops.forEach((stop) => stop());
}
