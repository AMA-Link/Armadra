import { afterEach, describe, expect, it, vi } from "vitest";

import { makeNode, testUuid } from "../test-support";
import { useCanvasStore } from "@/store/canvas-store";
import { setFlow, setFlowContainer, type FlowHandle } from "./flow-context";
import { useRealtimeStore } from "@/realtime/session";
import {
  REVEAL_RETRY_DELAYS,
  revealNewNode,
  zoomByStep,
  zoomToLevel,
} from "./use-flow-viewport";

/**
 * 新建节点之后的相机（契约 §3.4，#684）。
 *
 * 新建的节点每次都被送到眼前：居中，缩放让它占视口主方向的 1/φ，字号 ×
 * 缩放不低于 12px——总览缩放下新建也不会拿到一张读不了的缩略图。
 */

const NODE = {
  id: "n1",
  position: { x: 1000, y: 400 },
  measured: { width: 1280, height: 800 },
  width: 1280,
  height: 800,
  data: {},
};

type SetCenter = (
  x: number,
  y: number,
  options: { zoom: number; duration: number },
) => Promise<boolean>;

/** 只需要 `getBoundingClientRect`：`containerSize()` 只读这一个。 */
function fakeContainer(width: number, height: number): HTMLElement {
  return {
    getBoundingClientRect: () => ({ width, height }),
  } as unknown as HTMLElement;
}

function mountFlow(zoom: number, node: typeof NODE | null = NODE) {
  const setCenter = vi.fn<SetCenter>(() => Promise.resolve(true));
  const handle = {
    getViewport: () => ({ x: 0, y: 0, zoom }),
    getNode: (id: string) => (node && node.id === id ? node : undefined),
    setCenter,
  } as unknown as FlowHandle;
  setFlow(handle);
  return setCenter;
}

afterEach(() => {
  setFlow(null);
  setFlowContainer(null);
  vi.useRealTimers();
});

describe("revealNewNode", () => {
  it("在 27% 缩放下把相机抬到 100% 并对准节点中心", () => {
    const setCenter = mountFlow(0.27);

    revealNewNode("n1");

    expect(setCenter).toHaveBeenCalledTimes(1);
    const [x, y, options] = setCenter.mock.calls[0]!;
    expect([x, y]).toEqual([1000 + 1280 / 2, 400 + 800 / 2]);
    expect(options.zoom).toBe(1);
  });

  it("节点已经在眼前时也居中，缩放封顶在 1.25", () => {
    const setCenter = mountFlow(1);
    setFlowContainer(fakeContainer(4000, 3000));
    revealNewNode("n1");
    expect(setCenter).toHaveBeenCalledTimes(1);
    const options = setCenter.mock.calls[0]![2];
    // min(4000/1280, 3000/800) / φ = 1.93，夹到 1.25
    expect(options.zoom).toBe(1.25);
  });

  /**
   * Agent 用控制动词建的节点摆在发起它的那个节点右边，常常整块在屏幕外，
   * 而缩放本来就是 100%，所以每次都居中，缩放由首次显示规则决定。
   */
  it("画布放不下时缩放顶在字号下限 100%，节点在屏幕外也居中", () => {
    const setCenter = mountFlow(1);
    setFlowContainer(fakeContainer(800, 600));
    revealNewNode("n1");
    expect(setCenter).toHaveBeenCalledTimes(1);
    const [x, y, options] = setCenter.mock.calls[0]!;
    expect([x, y]).toEqual([1000 + 1280 / 2, 400 + 800 / 2]);
    expect(options.zoom).toBe(1);
  });

  it("React Flow 还没量过这个节点时相机不动", () => {
    vi.useFakeTimers();
    const setCenter = mountFlow(0.27, null);

    revealNewNode("n1");
    vi.advanceTimersByTime(REVEAL_RETRY_DELAYS.at(-1)! + 1);

    expect(setCenter).not.toHaveBeenCalled();
  });

  it("投影晚一拍落地时由重试补上，且只居中一次", () => {
    vi.useFakeTimers();
    let node: typeof NODE | null = null;
    const setCenter = vi.fn<SetCenter>(() => Promise.resolve(true));
    setFlow({
      getViewport: () => ({ x: 0, y: 0, zoom: 0.27 }),
      getNode: (id: string) => (node && node.id === id ? node : undefined),
      setCenter,
    } as unknown as FlowHandle);

    revealNewNode("n1");
    expect(setCenter).not.toHaveBeenCalled();

    node = NODE;
    vi.advanceTimersByTime(REVEAL_RETRY_DELAYS.at(-1)! + 1);
    expect(setCenter).toHaveBeenCalledTimes(1);
  });

  it("画布没挂载时什么都不做", () => {
    setFlow(null);
    expect(() => revealNewNode("n1")).not.toThrow();
  });
});

describe("手机上新建的节点（#684）", () => {
  const BOARD = testUuid(1);
  const ID = testUuid(7);

  function compact(matches: boolean) {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: matches && query.includes("max-width"),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
  }

  function load(size: { width: number; height: number } | undefined) {
    const node = makeNode("terminal", {
      id: ID,
      boardId: BOARD,
      position: { x: 1000, y: 400 },
      ...(size ? { size } : {}),
    });
    if (!size) delete (node as { size?: unknown }).size;
    useCanvasStore.getState().setDocument({
      board: {
        id: BOARD,
        workspaceId: testUuid(3),
        name: "Board",
        sortOrder: 0,
        viewport: { x: 0, y: 0, zoom: 1 },
        whiteboard: "",
        createdAt: "2026-09-20T00:00:00.000Z",
        updatedAt: "2026-09-20T00:00:00.000Z",
      },
      nodes: [node],
      edges: [],
    } as never);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("没写 size 的终端先缩到装得下（中心不动），量到新尺寸后再居中", () => {
    vi.useFakeTimers();
    compact(true);
    load(undefined);
    setFlowContainer(fakeContainer(390, 700));
    const measured = { width: 715, height: 442 };
    const setCenter = vi.fn<SetCenter>(() => Promise.resolve(true));
    setFlow({
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
      getNode: () => {
        const doc = useCanvasStore
          .getState()
          .document!.nodes.find((item) => item.id === ID)!;
        return {
          id: ID,
          position: doc.position,
          measured: { ...measured },
          width: measured.width,
          height: measured.height,
          data: {},
        };
      },
      setCenter,
    } as unknown as FlowHandle);

    revealNewNode(ID);

    const resized = useCanvasStore
      .getState()
      .document!.nodes.find((item) => item.id === ID)!;
    expect(resized.size).toEqual({ width: 273, height: 169 });
    // 中心 (1000 + 715/2, 400 + 442/2) 保持不变，取整到像素。
    expect(
      Math.abs(resized.position.x + 273 / 2 - (1000 + 715 / 2)),
    ).toBeLessThanOrEqual(0.5);
    expect(
      Math.abs(resized.position.y + 169 / 2 - (400 + 442 / 2)),
    ).toBeLessThanOrEqual(0.5);
    // React Flow 量到的还是缩小之前的矩形：不对着旧尺寸动相机。
    expect(setCenter).not.toHaveBeenCalled();

    measured.width = 273;
    measured.height = 169;
    vi.advanceTimersByTime(REVEAL_RETRY_DELAYS.at(-1)! + 1);
    expect(setCenter).toHaveBeenCalledTimes(1);
    const zoom = setCenter.mock.calls[0]![2].zoom;
    expect(12 * zoom).toBeGreaterThanOrEqual(12);
    // 新尺寸在手机竖屏里占主方向 1/φ（宽 390 对应 ≥ 100% 的字号下限）。
    expect((273 * zoom) / 390).toBeLessThanOrEqual(1);
  });

  it("调用方指定过别的尺寸、或不是手机时不缩", () => {
    compact(true);
    load({ width: 500, height: 309 });
    setFlowContainer(fakeContainer(390, 700));
    mountFlow(1);
    revealNewNode(ID);
    expect(useCanvasStore.getState().document!.nodes[0]!.size).toEqual({
      width: 500,
      height: 309,
    });

    compact(false);
    load(undefined);
    revealNewNode(ID);
    expect(useCanvasStore.getState().document!.nodes[0]!.size).toBeUndefined();
  });
});

describe("缩放取消跟随（#327）", () => {
  afterEach(() => useRealtimeStore.setState({ following: null }));

  function mountZoom(zoom: number) {
    const zoomTo = vi.fn(() => Promise.resolve(true));
    setFlow({
      getViewport: () => ({ x: 0, y: 0, zoom }),
      zoomTo,
    } as unknown as FlowHandle);
    return zoomTo;
  }

  it("zoomToLevel（缩放档位、100%）取消跟随", () => {
    const zoomTo = mountZoom(1);
    useRealtimeStore.setState({ following: 7 });
    zoomToLevel(0.5);
    expect(zoomTo).toHaveBeenCalled();
    expect(useRealtimeStore.getState().following).toBeNull();
  });

  it("zoomByStep（Dock 加减按钮与快捷键）取消跟随", () => {
    mountZoom(1);
    useRealtimeStore.setState({ following: 7 });
    zoomByStep(1);
    expect(useRealtimeStore.getState().following).toBeNull();
  });

  it("画布未就绪时不动跟随", () => {
    useRealtimeStore.setState({ following: 7 });
    zoomByStep(-1);
    expect(useRealtimeStore.getState().following).toBe(7);
  });
});
