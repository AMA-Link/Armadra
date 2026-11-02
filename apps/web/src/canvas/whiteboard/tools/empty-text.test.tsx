import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { Board, BoardDocument, Workspace } from "@armadra/shared";

/**
 * 空白处双击建文字 → 空着提交就不留对象（#714），有内容才保留。
 *
 * 用真的 canvas-store 与白板动作，不替身：要验的正是「建出来的对象
 * 空着走开之后，文档与撤销栈里都没有它」。React Flow 只借一个 DOM 容器与
 * 坐标换算，节点渲染换成直接挂 `InlineText`（它才是提交规则所在）。
 */

vi.mock("@/nodes/registry", () => {
  const meta = {
    labelKey: "node.sticky",
    icon: null,
    defaultSize: { width: 240, height: 200 },
    minSize: { width: 160, height: 120 },
    defaultColor: "#ffd60a",
    hasBridgeHandles: false,
  };
  const table: Record<string, typeof meta> = {
    terminal: meta,
    sticky: meta,
    group: meta,
    editor: meta,
    diff: meta,
    files: meta,
    browser: meta,
  };
  return {
    NODE_META: table,
    nodeMeta: (type: string) => table[type],
    DRAG_HANDLE_CLASS: "drag-handle",
    NODE_DRAG_HANDLE: ".drag-handle",
  };
});
vi.mock("@xyflow/react", () => ({
  useReactFlow: () => ({
    screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
  }),
  useStoreApi: () => ({
    getState: () => ({ domNode: document.querySelector(".react-flow") }),
  }),
}));
const { useCanvasStore, resetHistory } = await import("@/store/canvas-store");
const { InlineText } = await import("../nodes/InlineText");
const { useDoubleClickText } = await import("./use-double-click-text");
const { resetToolStore } = await import("../../interaction/tool-store");

const timestamp = "2026-11-02T00:00:00.000Z";
const workspace: Workspace = {
  id: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "One",
  rootPath: "/tmp/one",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  executionHostId: "",
  lastOpenedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const board: Board = {
  id: "019ff7d1-7419-74df-89e2-b1619d36ea7d",
  workspaceId: workspace.id,
  name: "Default",
  sortOrder: 0,
  viewport: { x: 0, y: 0, zoom: 1 },
  whiteboard: "",
  createdAt: timestamp,
  updatedAt: timestamp,
};

const state = () => useCanvasStore.getState();
const items = () => state().whiteboard.items;

/** 文字对象的最小渲染：空文本 = 自动进编辑，和 `TextNode` 一样。 */
function Harness() {
  useDoubleClickText();
  const all = useCanvasStore((current) => current.whiteboard.items);
  return (
    <>
      {all.map((item) =>
        item.kind === "text" ? (
          <InlineText
            key={item.id}
            itemId={item.id}
            text={item.text}
            field="text"
            color="#fff"
            fontSize={14}
            autoEdit={item.text.length === 0}
          />
        ) : null,
      )}
    </>
  );
}

function mount() {
  const host = document.createElement("div");
  host.className = "react-flow";
  host.innerHTML = '<div class="react-flow__pane"></div>';
  document.body.append(host);
  const view = render(<Harness />);
  const pane = host.querySelector(".react-flow__pane") as HTMLElement;
  const doubleClick = () =>
    act(() => {
      pane.dispatchEvent(
        new MouseEvent("dblclick", {
          bubbles: true,
          button: 0,
          clientX: 120,
          clientY: 80,
        }),
      );
    });
  const editor = () =>
    view.container.querySelector("textarea") as HTMLTextAreaElement | null;
  return { doubleClick, editor };
}

beforeEach(() => {
  document.body.innerHTML = "";
  resetToolStore();
  const document_: BoardDocument = { board, nodes: [], edges: [] };
  state().setWorkspace(workspace);
  state().setDocument(document_);
  resetHistory();
});
afterEach(cleanup);

describe("双击空白 → 空提交不留元素", () => {
  it("双击后建出一条空文字并选中，编辑框已经在", () => {
    const { doubleClick, editor } = mount();
    doubleClick();
    expect(items()).toEqual([
      expect.objectContaining({ kind: "text", text: "" }),
    ]);
    expect(state().selectedItemIds).toHaveLength(1);
    expect(editor()).not.toBeNull();
  });

  it("什么都不输入就失焦：对象没了，选区空了，撤销也复活不出它", () => {
    const { doubleClick, editor } = mount();
    doubleClick();
    act(() => {
      fireEvent.blur(editor()!);
    });
    expect(items()).toHaveLength(0);
    expect(state().selectedItemIds).toEqual([]);
    act(() => state().undo());
    expect(items()).toHaveLength(0);
  });

  it("按 Esc 提交空文字同样丢弃", () => {
    const { doubleClick, editor } = mount();
    doubleClick();
    act(() => {
      fireEvent.keyDown(editor()!, { key: "Escape" });
    });
    expect(items()).toHaveLength(0);
  });

  it("只输入了空白也算空", () => {
    const { doubleClick, editor } = mount();
    doubleClick();
    act(() => {
      fireEvent.change(editor()!, { target: { value: "  \n " } });
    });
    act(() => {
      fireEvent.blur(editor()!);
    });
    expect(items()).toHaveLength(0);
  });
});

describe("双击空白 → 输入了文字就保留", () => {
  it("输入后失焦：对象留着，文字写进文档", () => {
    const { doubleClick, editor } = mount();
    doubleClick();
    act(() => {
      fireEvent.change(editor()!, { target: { value: "你好" } });
    });
    act(() => {
      fireEvent.blur(editor()!);
    });
    expect(items()).toEqual([
      expect.objectContaining({ kind: "text", text: "你好" }),
    ]);
  });

  it("新建 + 输入只是一步撤销，撤掉后画布回到空", () => {
    const { doubleClick, editor } = mount();
    doubleClick();
    act(() => {
      fireEvent.change(editor()!, { target: { value: "你好" } });
    });
    act(() => {
      fireEvent.keyDown(editor()!, { key: "Escape" });
    });
    expect(items()).toHaveLength(1);
    act(() => state().undo());
    expect(items()).toHaveLength(0);
  });
});
