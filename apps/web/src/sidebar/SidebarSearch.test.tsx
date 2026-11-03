import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  BoardDocument,
  Workspace,
  WorkspaceSummary,
} from "@armadra/shared";

import { installDomPolyfills, TestProviders } from "../app/test-harness";
import { emptyWhiteboard } from "../canvas/whiteboard/model";
import { useCanvasStore } from "../store/canvas-store";
import { SidebarSearch } from "./SidebarSearch";

const api = vi.hoisted(() => ({
  listWorkspaces: vi.fn(),
  loadBoard: vi.fn(),
  fileIndex: vi.fn(),
  conversations: vi.fn(),
  openWorkspace: vi.fn(),
}));
vi.mock("../api/client", () => ({ runtimeApi: api }));
const openFile = vi.hoisted(() => vi.fn());
vi.mock("@/files/open-editor", () => ({ openFileInEditor: openFile }));

const timestamp = "2026-09-05T10:00:00.000Z";
const A = "019ff7d1-0d12-7421-833d-000000000001";
const B = "019ff7d1-0d12-7421-833d-000000000002";
const BOARD_A1 = "019ff7d1-0d12-7421-833d-0000000000a1";
const BOARD_A2 = "019ff7d1-0d12-7421-833d-0000000000a2";
const BOARD_B1 = "019ff7d1-0d12-7421-833d-0000000000b1";

const summary = (
  id: string,
  name: string,
  boards: { id: string; name: string }[],
  lastOpenedAt: string,
): WorkspaceSummary => ({
  id,
  name,
  rootPath: `/${name}`,
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  executionHostId: "",
  lastOpenedAt,
  createdAt: timestamp,
  updatedAt: timestamp,
  boards: boards.map((board) => ({ ...board, nodeCount: 0 })),
});

const workspaces = [
  summary(
    A,
    "Default",
    [
      { id: BOARD_A1, name: "Default" },
      { id: BOARD_A2, name: "画布 3" },
    ],
    "2026-09-05T11:00:00.000Z",
  ),
  summary(B, "后端服务", [{ id: BOARD_B1, name: "接口梳理" }], timestamp),
];

const style = { color: "black", size: "m" } as const;
function documentOf(
  workspaceId: string,
  boardId: string,
  name: string,
  nodes: BoardDocument["nodes"],
  texts: string[] = [],
): BoardDocument {
  return {
    board: {
      id: boardId,
      workspaceId,
      name,
      sortOrder: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      whiteboard: JSON.stringify({
        ...emptyWhiteboard(),
        items: texts.map((text, index) => ({
          id: `item-${index}`,
          kind: "text",
          text,
          x: 0,
          y: 0,
          w: 10,
          h: 10,
          z: index,
          style,
        })),
      }),
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    nodes,
    edges: [],
  };
}

const sticky = (id: string, boardId: string, title: string, content: string) =>
  ({
    id,
    boardId,
    type: "sticky",
    title,
    color: "#5B5BD6",
    position: { x: 0, y: 0 },
    labels: [],
    note: "",
    data: { kind: "sticky", content },
    createdAt: timestamp,
    updatedAt: timestamp,
  }) as BoardDocument["nodes"][number];

const terminal = (id: string, boardId: string, title: string) =>
  ({
    ...sticky(id, boardId, title, ""),
    type: "terminal",
    data: { kind: "terminal" },
  }) as BoardDocument["nodes"][number];

const current = documentOf(A, BOARD_A1, "Default", [
  terminal("n-claude", BOARD_A1, "Claude Code"),
  sticky("n-todo", BOARD_A1, "待办", "先修好保存队列的重试"),
]);
const docs: Record<string, BoardDocument> = {
  [BOARD_A2]: documentOf(A, BOARD_A2, "画布 3", []),
  [BOARD_B1]: documentOf(
    B,
    BOARD_B1,
    "接口梳理",
    [sticky("n-api", BOARD_B1, "接口清单", "鉴权、画布保存、导出")],
    ["限流策略"],
  ),
};

beforeAll(installDomPolyfills);

beforeEach(() => {
  api.listWorkspaces.mockResolvedValue(workspaces);
  api.loadBoard.mockImplementation(
    async (_workspaceId: string, boardId: string) => docs[boardId],
  );
  api.fileIndex.mockResolvedValue({
    entries: [{ name: "button.tsx", path: "src/ui/button.tsx" }],
    truncated: false,
    scanned: 1,
  });
  api.conversations.mockResolvedValue([]);
  api.openWorkspace.mockResolvedValue(undefined);
  const state = useCanvasStore.getState();
  state.setWorkspace(workspaces[0] as Workspace);
  state.setBoards([
    { id: BOARD_A1, name: "Default", sortOrder: 0 },
    { id: BOARD_A2, name: "画布 3", sortOrder: 1 },
  ]);
  state.setDocument(current);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

function renderSearch(onOpenChange = vi.fn()) {
  render(<SidebarSearch open onOpenChange={onOpenChange} />, {
    wrapper: TestProviders,
  });
  return { onOpenChange, input: screen.getByPlaceholderText("搜索") };
}

const rowOf = (text: string) =>
  screen.getByText(text).closest("[cmdk-item]") as HTMLElement;

describe("侧栏搜索：版式", () => {
  it("每行有类型图标，次级标签是右对齐的 command-meta，没有尾部对勾占位", async () => {
    renderSearch();
    const node = rowOf("Claude Code");
    expect(node.querySelector("svg")).not.toBeNull();
    const meta = node.querySelector('[data-slot="command-meta"]');
    expect(meta?.textContent).toBe("默认");
    expect(meta?.className).toContain("ml-auto");
    // 带 meta 的行里没有第二个 `ml-auto`（对勾被 CSS 隐藏，其它元素不抢空间）
    const autos = [...node.querySelectorAll("*")].filter((element) =>
      /\bml-auto\b/.test(element.getAttribute("class") ?? ""),
    );
    expect(autos.filter((element) => element.tagName !== "svg")).toEqual([
      meta,
    ]);
    // 标题可截断
    expect(within(node).getByText("Claude Code").className).toContain(
      "truncate",
    );
  });

  it("空查询列工作空间、全部画布（当前工作空间在前）与当前画布的节点", async () => {
    renderSearch();
    expect(await screen.findByText("工作空间")).toBeTruthy();
    // 工作空间一行，加上它名下那块画布行尾的标签
    expect(await screen.findAllByText("后端服务")).toHaveLength(2);
    const boards = screen
      .getAllByText("接口梳理")
      .map((element) => element.closest("[cmdk-item]"));
    expect(boards).toHaveLength(1);
    expect(
      rowOf("接口梳理").querySelector('[data-slot="command-meta"]')
        ?.textContent,
    ).toBe("后端服务");
    expect(screen.getByText("待办")).toBeTruthy();
    // 别的画布的内容在没输入前不去取
    expect(api.loadBoard).not.toHaveBeenCalled();
  });
});

describe("侧栏搜索：找得到什么", () => {
  it("别的工作空间的画布：回车切过去", async () => {
    const { input, onOpenChange } = renderSearch();
    fireEvent.change(input, { target: { value: "接口梳理" } });
    const row = await screen.findByText("接口梳理");
    expect(row.closest("[cmdk-item]")).not.toBeNull();
    fireEvent.click(row.closest("[cmdk-item]")!);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(useCanvasStore.getState().workspace?.id).toBe(B);
    expect(api.openWorkspace).toHaveBeenCalledWith(B);
  });

  it("拼音首字母：hb 找到「画布 3」", async () => {
    const { input } = renderSearch();
    fireEvent.change(input, { target: { value: "hb" } });
    expect(await screen.findByText("画布 3")).toBeTruthy();
  });

  it("别的工作空间的便签正文与白板文字，标签带工作空间与画布", async () => {
    const { input } = renderSearch();
    fireEvent.change(input, { target: { value: "导出" } });
    const sticky = (await screen.findByText("接口清单")).closest(
      "[cmdk-item]",
    )!;
    expect(
      sticky.querySelector('[data-slot="command-meta"]')?.textContent,
    ).toBe("后端服务 / 接口梳理");
    expect(sticky.textContent).toContain("鉴权、画布保存、导出");

    fireEvent.change(input, { target: { value: "限流" } });
    const item = (await screen.findByText("限流策略")).closest("[cmdk-item]")!;
    expect(screen.getByText("白板内容")).toBeTruthy();
    expect(item.querySelector('[data-slot="command-meta"]')?.textContent).toBe(
      "后端服务 / 接口梳理",
    );
  });

  it("当前工作空间的文件：选中交给编辑器", async () => {
    const { input, onOpenChange } = renderSearch();
    fireEvent.change(input, { target: { value: "button" } });
    const row = (await screen.findByText("button.tsx")).closest("[cmdk-item]")!;
    expect(screen.getByText("文件")).toBeTruthy();
    expect(row.querySelector('[data-slot="command-meta"]')?.textContent).toBe(
      "src/ui",
    );
    fireEvent.click(row);
    expect(openFile).toHaveBeenCalledWith("src/ui/button.tsx");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("没有结果时显示「无结果」", async () => {
    const { input } = renderSearch();
    fireEvent.change(input, { target: { value: "qzxvqzxv" } });
    await waitFor(() => expect(screen.getByText("无结果")).toBeTruthy());
  });
});

describe("侧栏搜索：同一块画布的节点", () => {
  it("选中会在当前画布上选中并居中，不碰工作空间", async () => {
    const { input } = renderSearch();
    fireEvent.change(input, { target: { value: "待办" } });
    fireEvent.click((await screen.findByText("待办")).closest("[cmdk-item]")!);
    await waitFor(() =>
      expect(useCanvasStore.getState().selectedNodeIds).toEqual(["n-todo"]),
    );
    expect(useCanvasStore.getState().workspace?.id).toBe(A);
  });
});

describe("侧栏搜索：关掉再开", () => {
  it("查询词清空", () => {
    const view = render(<SidebarSearch open onOpenChange={vi.fn()} />, {
      wrapper: TestProviders,
    });
    fireEvent.change(screen.getByPlaceholderText("搜索"), {
      target: { value: "待办" },
    });
    view.rerender(<SidebarSearch open={false} onOpenChange={vi.fn()} />);
    view.rerender(<SidebarSearch open onOpenChange={vi.fn()} />);
    expect(
      (screen.getByPlaceholderText("搜索") as HTMLInputElement).value,
    ).toBe("");
  });
});
