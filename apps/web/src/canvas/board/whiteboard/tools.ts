import type { CanvasNode, Position } from "@armadra/shared";
import {
  createHandTool,
  createSelectTool,
  type DomBoard,
  type Gesture,
  type PointerInput,
  type Tool,
} from "@armadra/board/dom";

import { usePreferencesStore } from "@/app/preferences-store";
import { isCanvasLocked } from "../../canvas-lock";
import type { CanvasToolId } from "../../interaction/tool-store";
import { inkBounds, translatePoints } from "../../whiteboard/ink";
import { lineBounds } from "../../whiteboard/geometry";
import { toItemId, type Item, type LinePoint } from "../../whiteboard/model";
import { strokeWidth } from "../../whiteboard/palette";
import {
  addItems,
  beginGesture,
  createItemId,
  endGesture,
  itemById,
  select,
  updateItem,
} from "../../whiteboard/store";
import { createTextAt } from "../../whiteboard/tools/create-text";
import {
  commitDraft,
  extendDraft,
  isClick,
  startDraft,
  type Draft,
} from "../../whiteboard/tools/draft";
import { applyDynamicSize } from "../../whiteboard/tools/dynamic-size";
import { snapToGrid } from "../../whiteboard/tools/grid";
import { wbKindOf } from "./kinds";
import { setEditing } from "./text-edit";

/**
 * 白板绘图工具（设计 §2.6）：每个工具在 `begin` 里决定是否进入手势；落成规则
 * 全部复用 `whiteboard/tools/draft.ts` 的纯函数，与 React Flow 版同一份。
 *
 * 进行中的一笔画在场景里的临时实体 `wb:~draft` 上（`history: "ignore"`、不进
 * 文档与撤销栈），所以预览与落成后是同一个 `paint`；松手才一次性写入文档。
 */

type Board = DomBoard<CanvasNode>;

export const DRAFT_ID = "wb:~draft";
const DRAFT_Z = Number.MAX_SAFE_INTEGER;
/** 线端点把手的名字（叠加层里的 `data-board-handle`），不含 n/s/e/w 字母。 */
export const LINE_HANDLE = /^p(\d+)$/;

const CURSORS: Partial<Record<CanvasToolId, string>> = {
  draw: "crosshair",
  highlight: "crosshair",
  geo: "crosshair",
  line: "crosshair",
  arrow: "crosshair",
  text: "text",
};

/** 触屏与压感笔给真实压力，鼠标恒为 0.5。 */
export function pressureOf(input: Pick<PointerInput, "type" | "pressure">) {
  if (input.type === "mouse") return 0.5;
  return input.pressure > 0 ? input.pressure : 0.5;
}

function snapped(input: PointerInput): Position {
  const { snap, gridSize } = usePreferencesStore.getState().whiteboard;
  return snapToGrid(input.world, gridSize, snap);
}

function drawable(board: Board, input: PointerInput): boolean {
  if (input.button !== 0 || input.target.type === "editable") return false;
  if (isCanvasLocked()) return false;
  return !board.gestureDeps.options?.().readOnly;
}

/* -------------------------------- 预览 ------------------------------------ */

function previewItem(draft: Draft): Item | null {
  if (draft.kind === "ink") {
    const width = strokeWidth(draft.style.size) * (draft.highlight ? 4 : 1);
    const box = inkBounds(draft.points, width);
    if (!(box.w > 0 && box.h > 0)) return null;
    return {
      id: "~draft",
      kind: "ink",
      ...box,
      z: 0,
      style: draft.style,
      highlight: draft.highlight,
      points: translatePoints(draft.points, -box.x, -box.y),
    } as Item;
  }
  if (draft.kind === "shape" && isClick(draft)) return null;
  return commitDraft(draft, "~draft");
}

function showDraft(board: Board, draft: Draft | null): void {
  const item = draft && previewItem(draft);
  board.scene.transact(
    (scene) => {
      if (!item) return void scene.remove(DRAFT_ID);
      scene.set({
        id: DRAFT_ID,
        kind: wbKindOf(item),
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
        z: DRAFT_Z,
        data: item,
      } as never);
    },
    { history: "ignore" },
  );
}

/* -------------------------------- 手势 ------------------------------------ */

function drawGesture(
  board: Board,
  first: PointerInput,
  tool: CanvasToolId,
): Gesture | null {
  const prefs = usePreferencesStore.getState().whiteboard;
  applyDynamicSize(prefs.dynamicSize, board.camera.get().zoom);
  let draft = startDraft(tool, snapped(first), pressureOf(first));
  if (!draft) return null;
  const extend = (input: PointerInput) =>
    (draft = extendDraft(draft!, snapped(input), pressureOf(input)));
  return {
    name: "draw",
    move(input) {
      showDraft(board, extend(input));
    },
    end(input) {
      const done = extend(input);
      showDraft(board, null);
      const item = commitDraft(done, createItemId());
      if (!item) return;
      addItems([item]);
      select([item.id]);
    },
    cancel: () => showDraft(board, null),
  };
}

/** 新建一条空文字并直接进入编辑；落点已是画布坐标。 */
export function createBoardText(at: Position): void {
  const id = createTextAt(at);
  setEditing({ id: toItemId(id), field: "text" });
}

/**
 * 文字工具：鼠标按下就建；手指要等抬起（第一根手指可能是捏合的开头），
 * 移动超过点击阈值或第二根手指按下（引擎取消手势）都不建。
 */
function textGesture(first: PointerInput): Gesture {
  const at = snapped(first);
  if (first.type === "mouse") {
    createBoardText(at);
    return { name: "text", move() {}, end() {}, cancel() {} };
  }
  let moved = false;
  return {
    name: "text",
    move(input) {
      if (
        Math.hypot(
          input.screen.x - first.screen.x,
          input.screen.y - first.screen.y,
        ) > 10
      ) {
        moved = true;
      }
    },
    end: () => {
      if (!moved) createBoardText(at);
    },
    cancel: () => {
      moved = true;
    },
  };
}

/** 拖直线的一个端点：每帧写文档，整段合并成一条历史（与旧版一致）。 */
function lineEndpointGesture(id: string, index: number): Gesture | null {
  const item = itemById(id);
  if (!item || item.kind !== "line") return null;
  const anchored: LinePoint[] = item.points.map(([x, y]) => [
    x + item.x,
    y + item.y,
  ]);
  beginGesture("whiteboard.line");
  let open = true;
  const close = () => {
    if (open) endGesture();
    open = false;
  };
  const apply = (input: PointerInput) => {
    const world = snapped(input);
    const next = anchored.map((p, at) =>
      at === index ? [world.x, world.y] : p,
    ) as LinePoint[];
    const box = lineBounds(next);
    updateItem(id, {
      x: box.x,
      y: box.y,
      w: Math.max(box.w, 1),
      h: Math.max(box.h, 1),
      points: next.map(([x, y]) => [x - box.x, y - box.y] as LinePoint),
    } as never);
  };
  return { name: "line-endpoint", move: apply, end: close, cancel: close };
}

/* -------------------------------- 工具 ------------------------------------ */

/** 选择工具：线端点把手归这里，其余全交给引擎的选择手势。 */
function selectWithLines(board: Board): Tool {
  const base = createSelectTool(board.gestureDeps);
  return {
    ...base,
    begin(input, b) {
      const t = input.target;
      if (t.type === "handle" && input.button === 0) {
        const match = LINE_HANDLE.exec(t.handle);
        if (match) {
          return board.gestureDeps.options?.().readOnly
            ? null
            : lineEndpointGesture(t.id.replace(/^wb:/, ""), Number(match[1]));
        }
      }
      return base.begin(input, b);
    },
  };
}

/** 当前工具 → 引擎工具。 */
export function createBoardTool(id: CanvasToolId, board: Board): Tool {
  if (id === "hand") return createHandTool(board.gestureDeps);
  if (id === "select") return selectWithLines(board);
  return {
    id,
    cursor: CURSORS[id] ?? "crosshair",
    begin(input) {
      if (!drawable(board, input)) return null;
      return id === "text" ? textGesture(input) : drawGesture(board, input, id);
    },
  };
}
