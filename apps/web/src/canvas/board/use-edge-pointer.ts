import * as React from "react";
import type { CanvasNode } from "@armadra/shared";
import type { DomBoard } from "@armadra/board/dom";

import { useCanvasStore } from "@/store/canvas-store";
import { edgeRouterFor } from "./edge-layout";
import { edgeTooltip, hitEdge } from "./edge-hover";

/**
 * 空白处的连线交互（B4）：按下选中、悬停给手形光标与提示。
 *
 * 引擎对「按在空白」的反应是开始框选，连线又不是引擎的命中对象，所以这里在
 * 舞台的捕获阶段先看一眼：命中连线就选中它并吞掉这次按下，引擎不再看见。
 * 命中的几何同时给右键菜单用（`edgeAt`）。
 */

export interface EdgePointer {
  /** 屏幕坐标（相对视口）处的连线 id。 */
  edgeAt(clientX: number, clientY: number): string | null;
  /** 在舞台上按下：命中连线则选中并返回 true（调用方吞掉事件）。 */
  press(event: PointerEvent | React.PointerEvent): boolean;
}

export function useEdgePointer(
  board: DomBoard<CanvasNode>,
  stage: React.RefObject<HTMLElement | null>,
): EdgePointer {
  const router = React.useMemo(() => edgeRouterFor(board), [board]);

  const edgeAt = React.useCallback(
    (clientX: number, clientY: number): string | null => {
      const rect = stage.current?.getBoundingClientRect();
      if (!rect) return null;
      const world = board.camera.screenToWorld({
        x: clientX - rect.left,
        y: clientY - rect.top,
      });
      return hitEdge(router, world, board.camera.get().zoom);
    },
    [board, router, stage],
  );

  const press = React.useCallback(
    (event: PointerEvent | React.PointerEvent): boolean => {
      if (event.button !== 0 || board.gestureActive()) return false;
      const target = event.target as Element;
      if (!target.hasAttribute("data-board-stage")) return false;
      const id = edgeAt(event.clientX, event.clientY);
      if (!id) return false;
      const state = useCanvasStore.getState();
      if (event.shiftKey) {
        const edges = state.selectedEdgeIds.includes(id)
          ? state.selectedEdgeIds.filter((other) => other !== id)
          : [...state.selectedEdgeIds, id];
        state.setSelection({ edges });
      } else {
        state.setSelection({ nodes: [], edges: [id], items: [] });
      }
      return true;
    },
    [board, edgeAt],
  );

  // 悬停：手形光标 + 原生提示（舞台元素的 `title`）。
  React.useEffect(() => {
    const element = stage.current;
    if (!element) return;
    let over: string | null = null;
    let saved = "";
    const onMove = (event: PointerEvent) => {
      if (event.buttons !== 0 || board.gestureActive()) return;
      const target = event.target as Element;
      const id = target.hasAttribute("data-board-stage")
        ? edgeAt(event.clientX, event.clientY)
        : null;
      if (id !== over) {
        over = id;
        const host = element.querySelector<HTMLElement>("[data-board-stage]");
        if (host) {
          if (id) {
            saved = host.style.cursor;
            host.style.cursor = "pointer";
          } else host.style.cursor = saved;
        }
      }
      // 提示文字会随投递结果变，每次移动都对一遍。
      const text = id ? edgeTooltip(id) : undefined;
      if (text) {
        if (element.title !== text) element.title = text;
      } else if (element.hasAttribute("title"))
        element.removeAttribute("title");
    };
    element.addEventListener("pointermove", onMove);
    return () => {
      element.removeEventListener("pointermove", onMove);
      element.removeAttribute("title");
    };
  }, [board, edgeAt, stage]);

  return React.useMemo(() => ({ edgeAt, press }), [edgeAt, press]);
}
