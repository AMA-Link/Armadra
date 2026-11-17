import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { CanvasNode } from "@armadra/shared";
import { createBoard } from "@armadra/board/dom";
import { BoardProvider } from "@armadra/board/react";

const store = vi.hoisted(() => ({
  document: { nodes: [] as unknown[] },
  focusNodeId: null as string | null,
  maximized: {} as Record<string, unknown>,
  workspace: { id: "w1", rootPath: "/tmp" },
  selectNodes: vi.fn(),
  updateNode: vi.fn(),
  updateNodeData: vi.fn(),
  setCollapsed: vi.fn(),
  maximizeNode: vi.fn(),
  restoreNode: vi.fn(),
  removeNodes: vi.fn(),
  resizeNode: vi.fn(),
  setNodeLabels: vi.fn(),
  setNodeNote: vi.fn(),
}));

/** GitHub 徽标自己要打接口；这里只关心 Frame 能渲出来。 */
vi.mock("@/panels/github/GithubReferenceBadge", () => ({
  GithubReferenceBadge: () => null,
}));

vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

import { installDomPolyfills } from "@/app/test-harness";
import { TooltipProvider } from "@/ui/tooltip";
import { ENTER_SETTLE_MS, setSettledSince } from "../flow/node-enter";
import { CardHost, GroupHost } from "./hosts";
import { GHOST_KIND, type BoardEntity } from "./model";

/** 节点与分组的宿主：缩放把手、拖动与入场标记、ghost 隐藏。 */

beforeAll(installDomPolyfills);
afterEach(cleanup);

function entity(
  id: string,
  kind: string,
  data: Partial<CanvasNode>,
): BoardEntity {
  return {
    id,
    kind,
    x: 0,
    y: 0,
    w: 240,
    h: 200,
    z: 1,
    data: {
      id,
      boardId: "b1",
      title: "标题",
      color: "#ffd60a",
      position: { x: 0, y: 0 },
      size: { width: 240, height: 200 },
      labels: [],
      note: "",
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
      ...data,
    } as CanvasNode,
  };
}

const sticky = (extra: Partial<CanvasNode> = {}) =>
  entity("n1", "card", {
    type: "sticky",
    data: { kind: "sticky", content: "" },
    ...extra,
  } as Partial<CanvasNode>);

function setup(target: BoardEntity, ui: (e: BoardEntity) => React.ReactNode) {
  const board = createBoard<CanvasNode>({
    kinds: { card: { layer: "world" }, group: { layer: "world" } },
  });
  board.scene.transact((draft) => draft.set(target), { history: "ignore" });
  const view = render(
    <BoardProvider value={board as never}>
      <TooltipProvider delayDuration={0}>{ui(target)}</TooltipProvider>
    </BoardProvider>,
  );
  return { board, ...view };
}

const handles = (container: HTMLElement) =>
  [
    ...container.querySelectorAll<HTMLElement>(
      '[data-slot="board-resize-handle"]',
    ),
  ].map((el) => el.dataset.boardHandle);

describe("CardHost", () => {
  it("没选中不画缩放把手，单选了画八个", () => {
    const target = sticky();
    const { board, container } = setup(target, (e) => <CardHost entity={e} />);
    expect(handles(container)).toEqual([]);
    act(() => board.setSelection(new Set([target.id])));
    expect(handles(container)).toHaveLength(8);
  });

  it("多选时不画把手", () => {
    const target = sticky();
    const { board, container } = setup(target, (e) => <CardHost entity={e} />);
    act(() => board.setSelection(new Set([target.id, "other"])));
    expect(handles(container)).toEqual([]);
  });

  it("折叠的节点高度钉死，只留左右两个把手", () => {
    const target = sticky({ collapsed: true });
    const { board, container } = setup(target, (e) => <CardHost entity={e} />);
    act(() => board.setSelection(new Set([target.id])));
    expect(handles(container).sort()).toEqual(["e", "w"]);
  });

  it("手势预览中写 data-dragging，松手撤掉", () => {
    const target = sticky();
    const { board, container } = setup(target, (e) => <CardHost entity={e} />);
    const host = () =>
      container.querySelector('[data-slot="node-host"]') as HTMLElement;
    expect(host().hasAttribute("data-dragging")).toBe(false);
    act(() => board.scene.preview(new Map([[target.id, { x: 10, y: 10 }]])));
    expect(host().getAttribute("data-dragging")).toBe("true");
  });

  it("画布载入后才挂上来的节点写 data-entering，刚载入时挂载的不写", () => {
    const target = sticky();
    setSettledSince(Date.now());
    const loading = setup(target, (e) => <CardHost entity={e} />);
    expect(
      loading.container
        .querySelector('[data-slot="node-host"]')
        ?.hasAttribute("data-entering"),
    ).toBe(false);
    loading.unmount();

    setSettledSince(Date.now() - ENTER_SETTLE_MS - 1);
    const created = setup(target, (e) => <CardHost entity={e} />);
    expect(
      created.container
        .querySelector('[data-slot="node-host"]')
        ?.getAttribute("data-entering"),
    ).toBe("true");
  });

  it("ghost 只隐藏，不卸载", () => {
    const target = { ...sticky(), kind: GHOST_KIND };
    const { container } = setup(target, (e) => <CardHost entity={e} />);
    const host = container.querySelector(
      '[data-slot="node-host"]',
    ) as HTMLElement;
    expect(host.style.display).toBe("none");
  });
});

describe("GroupHost", () => {
  it("单选时画八个缩放把手，框与标题照常", () => {
    const target = entity("g1", "group", {
      type: "group",
      title: "组",
      data: { kind: "group" },
    } as Partial<CanvasNode>);
    const { board, container } = setup(target, (e) => <GroupHost entity={e} />);
    expect(container.querySelector('[data-slot="group-frame"]')).not.toBeNull();
    expect(handles(container)).toEqual([]);
    act(() => board.setSelection(new Set([target.id])));
    expect(handles(container)).toHaveLength(8);
  });
});
