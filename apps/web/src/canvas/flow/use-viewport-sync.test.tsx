import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "../test-support";

type Handlers = {
  onChange: (viewport: { x: number; y: number; zoom: number }) => void;
  onEnd: (viewport: { x: number; y: number; zoom: number }) => void;
};
const captured: { handlers: Handlers | null } = { handlers: null };

vi.mock("@xyflow/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@xyflow/react")>()),
  useOnViewportChange: (handlers: Handlers) => {
    captured.handlers = handlers;
  },
}));

import { useCanvasStore } from "@/store/canvas-store";
import { setFlow, setFlowContainer, type FlowHandle } from "./flow-context";
import { applyBoardViewport, useViewportSync } from "./use-flow-viewport";

/**
 * 手机打开时只动相机（#730）：相机停在打开视口上的回调不写文档，所以自动保存
 * 的视口通道（`save/autosave`）不会有可保存的东西；用户真的动了才写。
 */

const BOARD = testUuid(1);
const DESKTOP = { x: 50, y: 100, zoom: 0.1 };

function boardDocument() {
  return {
    board: {
      id: BOARD,
      workspaceId: testUuid(3),
      name: "Board",
      sortOrder: 0,
      viewport: DESKTOP,
      whiteboard: "",
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z",
    },
    nodes: [
      {
        id: testUuid(7),
        boardId: BOARD,
        type: "sticky",
        position: { x: 1400, y: 2400 },
        size: { width: 260, height: 160 },
        data: { kind: "sticky", text: "" },
      },
    ],
    edges: [],
  } as never;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("max-width"),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  setFlowContainer({
    getBoundingClientRect: () => ({ width: 402, height: 700 }),
  } as unknown as HTMLElement);
  setFlow({
    getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    setViewport: vi.fn(() => Promise.resolve(true)),
  } as unknown as FlowHandle);
});

afterEach(() => {
  setFlow(null);
  setFlowContainer(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useViewportSync 与手机打开视口（#730）", () => {
  it("打开后相机回调落在打开视口上：文档视口不变", () => {
    const doc = boardDocument();
    useCanvasStore.getState().setDocument(doc);
    renderHook(() => useViewportSync());
    applyBoardViewport(doc);
    const camera = { x: -1329, y: -2130, zoom: 1 };
    captured.handlers!.onChange(camera);
    captured.handlers!.onEnd(camera);
    vi.advanceTimersByTime(1000);
    expect(useCanvasStore.getState().document!.board.viewport).toEqual(DESKTOP);
  });

  it("用户动了相机之后照常写回", () => {
    const doc = boardDocument();
    useCanvasStore.getState().setDocument(doc);
    renderHook(() => useViewportSync());
    applyBoardViewport(doc);
    captured.handlers!.onEnd({ x: -1329, y: -2130, zoom: 1 });
    const moved = { x: -1000, y: -2000, zoom: 1 };
    captured.handlers!.onEnd(moved);
    expect(useCanvasStore.getState().document!.board.viewport).toEqual(moved);
  });
});
