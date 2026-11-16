import * as React from "react";
import type { CanvasNode } from "@armadra/shared";
import type { Vec } from "@armadra/board/core";
import type { DomBoard, GestureFeedback } from "@armadra/board/dom";
import { useBoard, WorldOverlay } from "@armadra/board/react";

import { useCanvasStore } from "@/store/canvas-store";
import { ConnectionPath } from "../flow/edges/ConnectionLine";
import { isValidCanvasConnection } from "../flow/edges/connect";

/**
 * 拉线时的预览（B4）。
 *
 * 引擎的连线手势只发反馈（起点、指针、悬停的实体），缺省画一条直的虚线；这里
 * 接管它：画与旧引擎同一种线（`ConnectionPath`，起笔节点朝向指针那一侧的边中点
 * 出发的圆角折线，悬停目标上时用目标的真实矩形），并按判定表给悬停的节点标
 * `data-connect-target="valid" | "invalid"`，样式据此高亮或抖动（canvas.css）。
 *
 * 状态是模块级的小订阅：拖线时指针每动一下都变，不进 zustand。
 */

export interface ConnectPreview {
  from: string;
  to: Vec;
  over: string | null;
  status: "valid" | "invalid" | null;
}

let current: ConnectPreview | null = null;
const listeners = new Set<() => void>();

function publish(next: ConnectPreview | null): void {
  current = next;
  for (const listener of [...listeners]) listener();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function getConnectPreview(): ConnectPreview | null {
  return current;
}

/** 接管引擎的连线反馈；其余反馈（框选、绘制）原样交回引擎。返回还原函数。 */
export function installConnectFeedback(
  board: DomBoard<CanvasNode>,
): () => void {
  const deps = board.gestureDeps;
  const original = deps.feedback;
  let marked: HTMLElement | undefined;
  const unmark = () => {
    marked?.removeAttribute("data-connect-target");
    marked = undefined;
  };
  deps.feedback = (fb: GestureFeedback | null) => {
    if (fb?.type !== "connect") {
      unmark();
      publish(null);
      original?.(fb);
      return;
    }
    const state = useCanvasStore.getState();
    const status = fb.over
      ? isValidCanvasConnection(
          { source: fb.from, target: fb.over },
          { document: state.document, whiteboard: state.whiteboard },
        )
        ? "valid"
        : "invalid"
      : null;
    const host = fb.over ? board.hostOf(fb.over) : undefined;
    if (host !== marked) unmark();
    if (host && status) {
      host.setAttribute("data-connect-target", status);
      marked = host;
    }
    publish({ from: fb.from, to: fb.to, over: fb.over, status });
  };
  return () => {
    unmark();
    publish(null);
    deps.feedback = original;
  };
}

export function BoardConnectionLine() {
  const { scene } = useBoard<CanvasNode>();
  const preview = React.useSyncExternalStore(
    subscribe,
    getConnectPreview,
    getConnectPreview,
  );
  if (!preview) return null;
  const source = scene.bounds(preview.from);
  const target = preview.over ? scene.bounds(preview.over) : undefined;
  if (!source) return null;
  const box = (rect: { x: number; y: number; w: number; h: number }) => ({
    x: rect.x,
    y: rect.y,
    width: rect.w,
    height: rect.h,
  });
  return (
    <WorldOverlay layer="svg">
      <ConnectionPath
        from={box(source)}
        to={
          target
            ? box(target)
            : { x: preview.to.x, y: preview.to.y, width: 0, height: 0 }
        }
        snapped={target !== undefined}
        status={preview.status}
      />
    </WorldOverlay>
  );
}
