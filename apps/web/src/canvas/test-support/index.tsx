import * as React from "react";

import { TooltipProvider } from "@/ui/tooltip";
import { BoardHostProvider } from "../board/host-context";
import { act, render, type RenderResult } from "@testing-library/react";
import type { CanvasEdge, CanvasNode, CanvasNodeType } from "@armadra/shared";

import {
  emptyWhiteboard,
  type Item,
  type ItemStyle,
  type WhiteboardDoc,
} from "../whiteboard/model";

/**
 * 画布单测的共享夹具：造节点、造白板对象、把节点内容渲进画板宿主。
 */

const STAMP = "2026-09-06T00:00:00.000Z";

let counter = 0;

/** 稳定的假 uuid：同一个测试里按调用顺序递增，断言读起来不费劲。 */
export function testUuid(seed = ++counter): string {
  const hex = seed.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

export function makeNode(
  type: CanvasNodeType,
  overrides: Partial<CanvasNode> = {},
): CanvasNode {
  return {
    id: testUuid(),
    boardId: testUuid(1),
    type,
    title: type,
    color: "#0a84ff",
    position: { x: 0, y: 0 },
    size: { width: 240, height: 200 },
    labels: [],
    note: "",
    data: { kind: type },
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides,
  } as CanvasNode;
}

export function makeEdge(source: string, target: string): CanvasEdge {
  return {
    id: testUuid(),
    boardId: testUuid(1),
    source,
    target,
    kind: "link",
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

const DEFAULT_STYLE: ItemStyle = { color: "black", size: "m" };

/** 造一条白板对象。`kind` 决定它自己那几个字段的默认值。 */
export function makeItem(
  kind: Item["kind"] = "shape",
  overrides: Partial<Item> = {},
): Item {
  const base = {
    id: testUuid(),
    x: 0,
    y: 0,
    w: 120,
    h: 80,
    z: 0,
    style: DEFAULT_STYLE,
  };
  const specific: Record<Item["kind"], Record<string, unknown>> = {
    ink: { points: [[0, 0, 0.5]] },
    text: { text: "" },
    shape: { geo: "rectangle" },
    image: { assetPath: ".armadra/assets/0000000000000000.png" },
    line: {
      points: [
        [0, 0],
        [120, 80],
      ],
    },
  };
  return { ...base, kind, ...specific[kind], ...overrides } as Item;
}

export function makeWhiteboard(items: Item[] = []): WhiteboardDoc {
  return { ...emptyWhiteboard(), items };
}

export interface NodeRenderResult extends RenderResult {
  /** 换掉节点内容而不重挂：外层组件始终是同一个，状态与 DOM 保留。 */
  rerenderNode: (next: React.ReactNode) => void;
}

/**
 * 把 `children` 渲成一个画板宿主里的节点内容：与应用同样有 `TooltipProvider`
 * （节点里的图标钮用 `Tooltip`），并标明在画板宿主里（连线把手据此才画）。
 */
export function renderNode(children: React.ReactNode): NodeRenderResult {
  const frame = (content: React.ReactNode) => (
    <BoardHostProvider value>
      <TooltipProvider delayDuration={0}>{content}</TooltipProvider>
    </BoardHostProvider>
  );
  const result = render(frame(children));
  return {
    ...result,
    rerenderNode(next) {
      act(() => result.rerender(frame(next)));
    },
  };
}

/** 仅测试用：把 `testUuid` 的计数器归零。 */
export function resetTestUuids(): void {
  counter = 0;
}
