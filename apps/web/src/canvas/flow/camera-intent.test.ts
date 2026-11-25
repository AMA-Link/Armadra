import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeNode, testUuid } from "../test-support";
import { useCanvasStore } from "@/store/canvas-store";
import { useRealtimeStore } from "@/realtime/session";
import {
  CAMERA_INTENT_DELAYS,
  CAMERA_INTENT_SETTLE_MS,
  cameraIntentHolds,
  cancelCameraIntent,
  startCameraIntent,
} from "./camera-intent";
import { setFlow, setFlowContainer, type FlowHandle } from "./flow-context";
import { centerOnNode, revealNewNode } from "./use-flow-viewport";

/**
 * 相机意图（#1028）：新请求取消旧请求、量到尺寸才落地、保护期、卸载清计时器、
 * 居中 / 新建先取消跟随。flow 句柄是假的，时间是假的。
 */

type Rect = { x: number; y: number; w: number; h: number } | null;

function mountFlow(nodes: Record<string, Rect>) {
  const setCenter = vi.fn<
    (x: number, y: number, o?: { zoom?: number }) => Promise<boolean>
  >(() => Promise.resolve(true));
  setFlow({
    getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    getNode: (id: string) => {
      const r = nodes[id];
      return r
        ? {
            id,
            position: { x: r.x, y: r.y },
            width: r.w,
            height: r.h,
            measured: { width: r.w, height: r.h },
          }
        : undefined;
    },
    setCenter,
  } as unknown as FlowHandle);
  setFlowContainer({
    getBoundingClientRect: () => ({ width: 1600, height: 1000 }),
  } as unknown as HTMLElement);
  return setCenter;
}

function openBoard(boardId: string) {
  useCanvasStore.getState().setDocument({
    board: {
      id: boardId,
      workspaceId: testUuid(3),
      name: "b",
      sortOrder: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      whiteboard: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    nodes: [makeNode("terminal", { id: "a", boardId })],
    edges: [],
  } as never);
}

beforeEach(() => {
  vi.useFakeTimers();
  openBoard("b1");
});
afterEach(() => {
  cancelCameraIntent();
  setFlow(null);
  setFlowContainer(null);
  useRealtimeStore.setState({ following: null });
  vi.useRealTimers();
});

describe("相机意图", () => {
  it("量不到尺寸就一直试，量到那一次落地，之后不再动", () => {
    const rect: Record<string, Rect> = { a: { x: 0, y: 0, w: 0, h: 0 } };
    const setCenter = mountFlow(rect);
    centerOnNode("a");
    vi.advanceTimersByTime(320);
    expect(setCenter).not.toHaveBeenCalled();

    rect.a = { x: 100, y: 100, w: 200, h: 100 };
    vi.advanceTimersByTime(1000);
    expect(setCenter).toHaveBeenCalledTimes(1);
    expect(setCenter.mock.calls[0]!.slice(0, 2)).toEqual([200, 150]);
  });

  it("新请求取消旧请求：连点两行，旧目标剩下的重试不会把相机拉回去", () => {
    const rect: Record<string, Rect> = {
      a: { x: 0, y: 0, w: 0, h: 0 },
      b: { x: 1000, y: 0, w: 100, h: 100 },
    };
    const setCenter = mountFlow(rect);
    centerOnNode("a");
    centerOnNode("b");
    rect.a = { x: 0, y: 0, w: 100, h: 100 };
    vi.advanceTimersByTime(5000);
    expect(setCenter).toHaveBeenCalledTimes(1);
    expect(setCenter.mock.calls[0]!.slice(0, 2)).toEqual([1050, 50]);
  });

  it("卸载（取消）后所有计时器都清掉，不再触发", () => {
    const setCenter = mountFlow({ a: { x: 0, y: 0, w: 0, h: 0 } });
    centerOnNode("a");
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    cancelCameraIntent();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(setCenter).not.toHaveBeenCalled();
  });

  it("落地后清掉剩余的重试计时器", () => {
    mountFlow({ a: { x: 0, y: 0, w: 100, h: 100 } });
    centerOnNode("a");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("保护期：落地后一段时间内持有，过期放开；用户手势（取消）立刻放开", () => {
    mountFlow({ a: { x: 0, y: 0, w: 100, h: 100 } });
    expect(cameraIntentHolds()).toBe(false);
    centerOnNode("a");
    expect(cameraIntentHolds()).toBe(true);
    vi.advanceTimersByTime(CAMERA_INTENT_SETTLE_MS - 1);
    expect(cameraIntentHolds()).toBe(true);
    vi.advanceTimersByTime(2);
    expect(cameraIntentHolds()).toBe(false);

    centerOnNode("a");
    expect(cameraIntentHolds()).toBe(true);
    cancelCameraIntent();
    expect(cameraIntentHolds()).toBe(false);
  });

  it("换了板：意图作废，不再持有也不再动相机", () => {
    const rect: Record<string, Rect> = { a: { x: 0, y: 0, w: 0, h: 0 } };
    const setCenter = mountFlow(rect);
    centerOnNode("a");
    openBoard("b2");
    rect.a = { x: 0, y: 0, w: 100, h: 100 };
    vi.advanceTimersByTime(5000);
    expect(setCenter).not.toHaveBeenCalled();
    expect(cameraIntentHolds()).toBe(false);
  });

  it("居中与新建都先取消跟随", () => {
    mountFlow({ a: { x: 0, y: 0, w: 100, h: 100 } });
    useRealtimeStore.setState({ following: 7 });
    centerOnNode("a");
    expect(useRealtimeStore.getState().following).toBeNull();

    useRealtimeStore.setState({ following: 7 });
    revealNewNode("a");
    expect(useRealtimeStore.getState().following).toBeNull();
  });

  it("时间表最后一档在保护期之内", () => {
    expect(Math.max(...CAMERA_INTENT_DELAYS)).toBeLessThan(
      CAMERA_INTENT_SETTLE_MS,
    );
    let calls = 0;
    startCameraIntent(() => ++calls >= 3);
    vi.advanceTimersByTime(5000);
    expect(calls).toBe(3);
  });
});
