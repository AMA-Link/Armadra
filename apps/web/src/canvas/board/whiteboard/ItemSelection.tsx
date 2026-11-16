import * as React from "react";
import type { CanvasNode } from "@armadra/shared";
import { useBoard } from "@armadra/board/react";
import type { DomBoard } from "@armadra/board/dom";

import { useCanvasReadOnly } from "@/store/canvas/presence";
import { useCanvasLocked } from "../../canvas-lock";
import { isItemId, type Item } from "../../whiteboard/model";
import { getEditing, subscribeEditing } from "./text-edit";

/**
 * 选中的白板对象的选择框与把手（叠加层，屏幕坐标）。
 *
 * Canvas 上的对象没有 DOM 宿主，所以选择框与 8 个缩放把手由这里画：把手带
 * `data-board-handle`，外层带 `data-board-id`，引擎的缺省目标解析就认得出它们
 * （与节点宿主里的把手同一套约定与样式类）。线只给两端的圆点把手。
 */

const ALL = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
const SIDES = ["e", "w"] as const;

/** 相机、场景（含手势预览）、选区任何一个变了就重渲。 */
export function useBoardTick(board: DomBoard<CanvasNode>): number {
  const version = React.useRef(0);
  return React.useSyncExternalStore(
    React.useCallback(
      (notify) => {
        const bump = () => {
          version.current += 1;
          notify();
        };
        const stops = [
          board.camera.subscribe(bump),
          board.scene.subscribe(bump),
          board.on("selection", bump),
        ];
        return () => stops.forEach((stop) => stop());
      },
      [board],
    ),
    () => version.current,
  );
}

/** 选区里有没有白板对象：只在选区变化时重渲，平移 / 缩放不会。 */
function useHasSelectedItem(board: DomBoard<CanvasNode>): boolean {
  return React.useSyncExternalStore(
    React.useCallback((notify) => board.on("selection", notify), [board]),
    () => [...board.selection()].some(isItemId),
    () => false,
  );
}

/**
 * 外层只看「有没有选中白板对象」：没有就什么都不订，相机每动一步都不碰 React。
 * 框的位置跟着相机，所以真有选中的时候才由内层订相机与场景。
 */
export function ItemSelection() {
  const board = useBoard<CanvasNode>();
  return useHasSelectedItem(board) ? <SelectedItems board={board} /> : null;
}

function SelectedItems({ board }: { board: DomBoard<CanvasNode> }) {
  useBoardTick(board);
  const readOnly = useCanvasReadOnly();
  const locked = useCanvasLocked();
  const editing = React.useSyncExternalStore(
    subscribeEditing,
    getEditing,
    () => null,
  );
  const ids = [...board.selection()].filter(isItemId);
  const single = ids.length === 1 && board.selection().size === 1;
  const { x, y, zoom } = board.camera.get();

  return ids.map((id) => {
    const entity = board.scene.get(id);
    const box = board.scene.bounds(id);
    if (!entity || !box) return null;
    const item = entity.data as unknown as Item;
    const handles =
      single && !readOnly && !locked && editing?.id !== id
        ? item.kind === "line"
          ? null
          : item.kind === "text"
            ? SIDES
            : ALL
        : [];
    const style: React.CSSProperties = {
      position: "absolute",
      left: box.x * zoom + x,
      top: box.y * zoom + y,
      width: box.w * zoom,
      height: box.h * zoom,
      outline: "1.5px solid var(--brand)",
      outlineOffset: 2,
      pointerEvents: "none",
    };
    return (
      <div key={id} data-board-id={id} data-slot="item-selection" style={style}>
        {handles?.map((handle) => (
          <span
            key={handle}
            data-board-handle={handle}
            className="board-resize-handle"
            style={{ pointerEvents: "auto" }}
          />
        ))}
        {handles === null &&
        single &&
        !readOnly &&
        !locked &&
        item.kind === "line"
          ? item.points.map(([px, py], index) => (
              <span
                key={index}
                data-board-handle={`p${index}`}
                style={{
                  position: "absolute",
                  left: ((px * box.w) / (item.w || 1)) * zoom - 6,
                  top: ((py * box.h) / (item.h || 1)) * zoom - 6,
                  width: 12,
                  height: 12,
                  borderRadius: 6,
                  background: "var(--panel)",
                  border: "1.5px solid var(--brand)",
                  cursor: "grab",
                  pointerEvents: "auto",
                }}
              />
            ))
          : null}
      </div>
    );
  });
}
