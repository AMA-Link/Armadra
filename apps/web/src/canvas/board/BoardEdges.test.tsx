// @vitest-environment jsdom
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type {
  BoardDocument,
  CanvasNode,
  WorkspaceEvent,
} from "@armadra/shared";
import type { Entity } from "@armadra/board/core";
import { createBoard } from "@armadra/board/dom";
import { BoardView } from "@armadra/board/react";

import { installDomPolyfills } from "@/app/test-harness";
import { makeEdge, makeNode } from "@/canvas/test-support";
import { useCanvasStore } from "@/store/canvas-store";
import { dispatchWorkspaceEvent } from "@/api/events";
import { TooltipProvider } from "@/ui/tooltip";
import { DELIVERY_FLASH_MS, useDeliveryStore } from "@/agent/delivery-store";
import { BoardEdges } from "./BoardEdges";
import { edgeEntity, edgeKinds } from "./edge-model";

/**
 * 连线层的渲染：画的是两个矩形相对边中点之间的路线、箭头按类型出、标签在缩放
 * 够大时才画、选中与投递的样子。几何本身在 `edge-layout.test.ts`、
 * `flow/edges/link-visual.test.ts`。
 */

beforeAll(installDomPolyfills);

beforeEach(() => {
  // 闪动有一个明确的终点，所以时间在这一组里是一个值。
  vi.useFakeTimers({ shouldAdvanceTime: true });
  useDeliveryStore.getState().reset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useCanvasStore.setState({ document: null, selectedEdgeIds: [] });
});

const A = "019ff7d1-0d12-7421-833d-2c5e8d64ed01";
const B = "019ff7d1-0d12-7421-833d-2c5e8d64ed02";
const EDGE = "019ff7d1-0d12-7421-833d-2c5e8d64ed03";

function sceneNode(
  id: string,
  type: CanvasNode["type"],
  x: number,
  title: string,
  y = 0,
): Entity<CanvasNode> {
  return {
    id,
    kind: type,
    x,
    y,
    w: 100,
    h: 100,
    z: 1,
    data: makeNode(type, { id, title }),
  };
}

function renderEdge(
  sourceType: CanvasNode["type"],
  targetType: CanvasNode["type"],
  options: {
    selected?: boolean;
    zoom?: number;
    role?: "peer" | "supervises";
    /** 子（目标）节点的左上角；缺省 (300, 0)，与主并排。 */
    targetAt?: { x: number; y: number };
  } = {},
) {
  const targetAt = options.targetAt ?? { x: 300, y: 0 };
  const board = createBoard<CanvasNode>({
    kinds: {
      terminal: { layer: "world" },
      sticky: { layer: "world" },
      editor: { layer: "world" },
      ...edgeKinds(),
    },
    camera: { x: 0, y: 0, zoom: options.zoom ?? 1 },
  });
  board.scene.transact(
    (draft) => {
      draft.set(sceneNode(A, sourceType, 0, "planner"));
      draft.set(sceneNode(B, targetType, targetAt.x, "codex-1", targetAt.y));
      draft.set(
        edgeEntity({
          id: EDGE,
          type: "link",
          source: A,
          target: B,
          data: options.role === undefined ? {} : { role: options.role },
        }),
      );
    },
    { history: "ignore" },
  );
  useCanvasStore.setState({
    selectedEdgeIds: options.selected ? [EDGE] : [],
  });
  return render(
    <BoardView board={board}>
      <BoardEdges />
    </BoardView>,
  );
}

function edgeGroup(container: HTMLElement): SVGGElement {
  const group = container.querySelector('[data-slot="link-edge"]');
  expect(group).not.toBeNull();
  return group as SVGGElement;
}

const mainPath = (container: HTMLElement) =>
  edgeGroup(container).querySelector("path") as SVGPathElement;

describe("上下文连线", () => {
  it("画的是两个矩形相对边中点之间的路线", () => {
    const { container } = renderEdge("terminal", "terminal");
    const d = mainPath(container).getAttribute("d");
    expect(d).toMatch(/^M 100,50/u);
    expect(d).toMatch(/ 300,50$/u);
  });

  it("终端 ↔ 终端画两个箭头，内容 → 终端只画一个", () => {
    const both = renderEdge("terminal", "terminal");
    // 主路径 + 两个箭头。
    expect(edgeGroup(both.container).querySelectorAll("path")).toHaveLength(3);
    cleanup();

    const one = renderEdge("sticky", "terminal");
    expect(edgeGroup(one.container).querySelectorAll("path")).toHaveLength(2);
  });

  it("内容 ↔ 内容一个箭头都不画", () => {
    const { container } = renderEdge("sticky", "editor");
    expect(edgeGroup(container).querySelectorAll("path")).toHaveLength(1);
  });

  it("终端 ↔ 终端的标签是「共享上下文」", () => {
    const { container } = renderEdge("terminal", "terminal");
    expect(edgeGroup(container).querySelector("text")?.textContent).toBe(
      "共享上下文",
    );
  });

  it("中点标签按被读取的那一端的类型翻译", () => {
    const { container } = renderEdge("sticky", "terminal");
    expect(edgeGroup(container).querySelector("text")?.textContent).toBe(
      "🗒 便签",
    );
  });

  it("缩小时标签按屏幕字号放大，小于 0.3 时不画", () => {
    const small = renderEdge("sticky", "terminal", { zoom: 0.5 });
    const text = edgeGroup(small.container).querySelector("text");
    // 屏幕上仍是 11px：画布单位里是 22。
    expect(text?.getAttribute("font-size")).toBe("22");
    cleanup();

    const tiny = renderEdge("sticky", "terminal", { zoom: 0.25 });
    expect(edgeGroup(tiny.container).querySelector("text")).toBeNull();
  });

  it("选中时线变粗并换成品牌色", () => {
    const plain = renderEdge("terminal", "terminal");
    expect(mainPath(plain.container).style.strokeWidth).toBe("2");
    // 上下文线用专用的 `--link-context`，与簇色分开（用户硬性要求）。
    expect(edgeGroup(plain.container).style.color).toBe("var(--link-context)");
    cleanup();

    const picked = renderEdge("terminal", "terminal", { selected: true });
    expect(mainPath(picked.container).style.strokeWidth).toBe("3.5");
    expect(edgeGroup(picked.container).style.color).toBe("var(--brand)");
  });

  /**
   * 投递（设计 §10）。闪动是**一次事件**：两秒之内这条边高亮并有一段流动的
   * 虚线，之后自己回到常态；悬停提示留着，因为「最近一次」比「刚刚」长命。
   */
  it("一次投递让这条边闪一下，两秒后自己停", () => {
    act(() => {
      dispatchWorkspaceEvent({
        type: "agent.delivery",
        traceId: "t-1",
        sourceNodeId: A,
        targetNodeId: B,
        outcome: "delivered",
      } as WorkspaceEvent);
    });
    const { container } = renderEdge("terminal", "terminal");
    expect(edgeGroup(container).dataset.delivery).toBe("true");
    expect(
      edgeGroup(container).querySelector(".anim-delivery-flow"),
    ).not.toBeNull();
    // 最近一次投递写进悬停提示（原生 `<title>`）。
    expect(edgeGroup(container).querySelector("title")).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(DELIVERY_FLASH_MS + 10);
    });
    expect(edgeGroup(container).dataset.delivery).toBeUndefined();
    expect(
      edgeGroup(container).querySelector(".anim-delivery-flow"),
    ).toBeNull();
  });
});

/**
 * 派发边（ui-wave2 §3.2）。方向不能只写在悬停提示里：一个箭头指向从，
 * 颜色是这一簇的簇色，标签「派发」。
 */
describe("派发边", () => {
  beforeEach(() => {
    const agent = (id: string) =>
      makeNode("terminal", {
        id,
        data: { kind: "terminal", agent: { id: "claude" } },
      } as Partial<CanvasNode>);
    useCanvasStore.setState({
      document: {
        board: {} as BoardDocument["board"],
        nodes: [agent(A), agent(B)],
        edges: [{ ...makeEdge(A, B), id: EDGE, role: "supervises" }],
      },
    });
  });

  it("只画一个指向从的箭头，颜色是簇色", () => {
    const peer = renderEdge("terminal", "terminal");
    // 对等的终端 ↔ 终端是两个箭头，颜色是上下文线色。
    expect(edgeGroup(peer.container).querySelectorAll("path")).toHaveLength(3);
    expect(edgeGroup(peer.container).style.color).toBe("var(--link-context)");
    expect(edgeGroup(peer.container).dataset.role).toBeUndefined();
    cleanup();

    const lead = renderEdge("terminal", "terminal", { role: "supervises" });
    const group = edgeGroup(lead.container);
    expect(group.dataset.role).toBe("supervises");
    expect(group.style.color).toBe("var(--node-color-1)");
    // 主路径 + 一个箭头。
    expect(group.querySelectorAll("path")).toHaveLength(2);
    expect(group.querySelector("title")?.textContent).toContain(
      "派发 @planner → @codex-1",
    );
  });

  it("常驻标签「派发」；选中时换成品牌色", () => {
    const lead = renderEdge("terminal", "terminal", { role: "supervises" });
    expect(edgeGroup(lead.container).querySelector("text")?.textContent).toBe(
      "派发",
    );
    cleanup();

    const picked = renderEdge("terminal", "terminal", {
      role: "supervises",
      selected: true,
    });
    const group = edgeGroup(picked.container);
    expect(group.querySelector("text")?.textContent).toBe("派发");
    expect(group.style.color).toBe("var(--brand)");
  });

  it("纵向布局时从主的底边中点出发、落在子的顶边中点", () => {
    const lead = renderEdge("terminal", "terminal", {
      role: "supervises",
      targetAt: { x: 300, y: 300 },
    });
    // 主在 (0,0) 100×100，子在 (300,300)：底边中点 (50,100)，顶边中点 (350,300)。
    const d = mainPath(lead.container).getAttribute("d");
    expect(d).toMatch(/^M 50,100/u);
    expect(d).toMatch(/ 350,300$/u);
  });

  it("子被拖到主的上方时改走就近边：主顶 → 子底", () => {
    const lead = renderEdge("terminal", "terminal", {
      role: "supervises",
      targetAt: { x: 20, y: -400 },
    });
    const d = mainPath(lead.container).getAttribute("d");
    expect(d).toMatch(/^M 50,0/u);
    expect(d).toMatch(/ 70,-300$/u);
  });

  it("子与主并排时改走就近边：主右 → 子左", () => {
    const lead = renderEdge("terminal", "terminal", { role: "supervises" });
    const d = mainPath(lead.container).getAttribute("d");
    expect(d).toMatch(/^M 100,50/u);
    expect(d).toMatch(/ 300,50$/u);
  });
});

/** 内容引用（白板对象或 Frame → 节点）：虚线加箭头，选中时中点上多一个删除钮。 */
describe("内容引用", () => {
  const REF = "019ff7d1-0d12-7421-833d-2c5e8d64ed04";

  function renderReference(selected: boolean) {
    const board = createBoard<CanvasNode>({
      kinds: {
        terminal: { layer: "world" },
        shape: { layer: "world" },
        ...edgeKinds(),
      },
      camera: { x: 0, y: 0, zoom: 1 },
    });
    board.scene.transact(
      (draft) => {
        draft.set(sceneNode("wb:abc", "terminal", 0, "shape"));
        draft.set({ ...sceneNode(B, "terminal", 300, "codex-1") });
        draft.set(
          edgeEntity({
            id: REF,
            type: "reference",
            source: "wb:abc",
            target: B,
          }),
        );
      },
      { history: "ignore" },
    );
    useCanvasStore.setState({ selectedEdgeIds: selected ? [REF] : [] });
    return render(
      <TooltipProvider delayDuration={0}>
        <BoardView board={board}>
          <BoardEdges />
        </BoardView>
      </TooltipProvider>,
    );
  }

  it("画虚线与一个指向节点的箭头，没选中时带标签", () => {
    const { container } = renderReference(false);
    const group = container.querySelector(
      '[data-slot="reference-edge"]',
    ) as SVGGElement;
    expect(group).not.toBeNull();
    const [line, arrow] = group.querySelectorAll("path");
    expect((line as SVGPathElement).style.strokeDasharray).toBe("6 5");
    expect(arrow).toBeTruthy();
    expect(group.querySelector('[data-slot="edge-label"]')).not.toBeNull();
    expect(
      container.querySelector('[data-slot="reference-remove"]'),
    ).toBeNull();
  });

  it("选中后标签让位给删除钮，线与箭头换成品牌色", () => {
    const { container } = renderReference(true);
    const group = container.querySelector(
      '[data-slot="reference-edge"]',
    ) as SVGGElement;
    expect(group.style.color).toBe("var(--brand)");
    expect(group.querySelector('[data-slot="edge-label"]')).toBeNull();
    expect(
      container.querySelector('[data-slot="reference-remove"]'),
    ).not.toBeNull();
  });
});
