import * as React from "react";
import type { Position } from "@armadra/shared";

/**
 * 全局画布句柄（归属 canvas）。
 *
 * `BoardWorkspace` 挂载时把引擎的相机与场景适配成这一组方法登记进来
 * （`board/flow-handle.ts`）、卸载时清掉；Dock / 命令面板 / 侧栏 / store 门面
 * 通过这里拿句柄，不各自去碰引擎实例。
 *
 * 画布没挂载（启动页、单测）时一律返回 null，调用方必须自己兜底。
 */

export interface FlowViewport {
  x: number;
  y: number;
  zoom: number;
}

/** 画布上一个对象（节点、分组、白板对象）的几何；尺寸与文档一致。 */
export interface FlowNode {
  id: string;
  parentId?: string;
  selected?: boolean;
  /** 相对父 Frame（顶层相对画布）的位置。 */
  position: Position;
  width?: number;
  height?: number;
  measured?: { width?: number; height?: number };
  /** 画布坐标下的绝对位置；没有时 `position` 就是绝对位置。 */
  internals?: { positionAbsolute: Position; z?: number };
}

/** 画布真正需要的那部分句柄；测试里造一个假的很便宜。 */
export interface FlowHandle {
  getViewport(): FlowViewport;
  setViewport(
    viewport: FlowViewport,
    options?: { duration?: number },
  ): Promise<boolean>;
  screenToFlowPosition(point: Position): Position;
  zoomTo(zoom: number, options?: { duration?: number }): Promise<boolean>;
  setCenter(
    x: number,
    y: number,
    options?: { zoom?: number; duration?: number },
  ): Promise<boolean>;
  getNode(id: string): FlowNode | undefined;
  getNodes(): FlowNode[];
}

let current: FlowHandle | null = null;
let container: HTMLElement | null = null;
const listeners = new Set<() => void>();

export function getFlow(): FlowHandle | null {
  return current;
}

export function setFlow(flow: FlowHandle | null): void {
  if (current === flow) return;
  current = flow;
  for (const listener of listeners) listener();
}

/** 画布容器（引擎舞台元素）。最大化与 fitView 要量它的像素尺寸。 */
export function setFlowContainer(element: HTMLElement | null): void {
  if (container === element) return;
  container = element;
  for (const listener of [...containerListeners]) listener();
}

const containerListeners = new Set<() => void>();

/** 订阅舞台元素（光标、评论钉要往它上面挂指针监听）。 */
export function useFlowContainer(): HTMLElement | null {
  return React.useSyncExternalStore(
    (listener) => {
      containerListeners.add(listener);
      return () => containerListeners.delete(listener);
    },
    getFlowContainer,
    () => null,
  );
}

export function getFlowContainer(): HTMLElement | null {
  return container;
}

/**
 * 画布容器的像素尺寸。没挂载时返回 `{width: 0, height: 0}`——调用方拿到的
 * 仍是合法尺寸，只是没有意义，总比抛异常好。
 */
export function containerSize(): { width: number; height: number } {
  if (!container) return { width: 0, height: 0 };
  const rect = container.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 订阅挂载 / 卸载；画布重建时组件会重新渲染并拿到新的实例。 */
export function useFlowHandle(): FlowHandle | null {
  return React.useSyncExternalStore(subscribe, getFlow, () => null);
}

/** 屏幕坐标 → 画布坐标；画布未挂载时原样返回（右键菜单的兜底）。 */
export function screenToPage(point: Position): Position {
  const flow = current;
  if (!flow) return point;
  return flow.screenToFlowPosition({ x: point.x, y: point.y });
}

/** 会话侧栏 / 命令面板点一行 → 画布居中到那个节点。 */
export const CENTER_NODE_EVENT = "armadra:canvas:center-node";

export function requestCenterOnNode(nodeId: string): void {
  window.dispatchEvent(
    new CustomEvent(CENTER_NODE_EVENT, { detail: { nodeId } }),
  );
}
