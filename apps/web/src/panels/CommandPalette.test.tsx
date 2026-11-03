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
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { BoardDocument, Conversation, Workspace } from "@armadra/shared";

import { installDomPolyfills, TestProviders } from "../app/test-harness";
import { useCanvasStore } from "../store/canvas-store";
import { commandKeysLabel, setShortcutsEnabled } from "../keybindings";
import { CommandPalette, RAN_MARK_MS } from "./CommandPalette";

const conversations = vi.fn();
const listWorkspaces = vi.fn();
const loadBoard = vi.fn();
const fileIndex = vi.fn();

vi.mock("../api/client", () => ({
  runtimeApi: {
    agents: vi.fn().mockResolvedValue([]),
    settings: vi.fn().mockResolvedValue({ ssh: { hosts: [] } }),
    conversations: (...args: unknown[]) => conversations(...args),
    listWorkspaces: (...args: unknown[]) => listWorkspaces(...args),
    loadBoard: (...args: unknown[]) => loadBoard(...args),
    fileIndex: (...args: unknown[]) => fileIndex(...args),
    openWorkspace: vi.fn().mockResolvedValue(undefined),
  },
}));

const timestamp = "2026-09-04T10:00:00.000Z";

const workspace: Workspace = {
  id: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "repo",
  rootPath: "/repo",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  executionHostId: "",
  lastOpenedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const BOARD_ID = "019ff7d1-0d12-7421-833d-2c5e8d64ed30";

const document: BoardDocument = {
  board: {
    id: BOARD_ID,
    workspaceId: workspace.id,
    name: "Default",
    sortOrder: 0,
    viewport: { x: 0, y: 0, zoom: 1 },
    whiteboard: "",
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  nodes: [],
  edges: [],
};

const row: Conversation = {
  provider: "claude",
  sessionId: "8f0f4e2c-1111-4b6f-9d21-2c5e8d64ed99",
  title: "重构保存队列",
  cwd: "/repo/apps/web",
  updatedAt: timestamp,
  bytes: 4096,
};

beforeAll(installDomPolyfills);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

beforeEach(() => {
  setShortcutsEnabled(true);
  conversations.mockResolvedValue([row]);
  listWorkspaces.mockResolvedValue([]);
  loadBoard.mockResolvedValue(undefined);
  fileIndex.mockResolvedValue({ entries: [], truncated: false, scanned: 0 });
  useCanvasStore.setState({
    workspace,
    boardId: BOARD_ID,
    document,
    selectedNodeIds: [],
    panels: { ...useCanvasStore.getState().panels, palette: true },
  });
});

function renderPalette() {
  return render(<CommandPalette />, { wrapper: TestProviders });
}

describe("命令面板的历史对话分组", () => {
  it("列出 Runtime 索引里的对话（标题 + 目录名）", async () => {
    renderPalette();
    expect(await screen.findByText("重构保存队列")).toBeTruthy();
    expect(screen.getByText("web")).toBeTruthy();
  });

  it("选中一条会开出带 resume 启动行的终端节点", async () => {
    const { container } = renderPalette();
    const item = await screen.findByText("重构保存队列");
    const option = item.closest("[cmdk-item]") as HTMLElement;
    option.click();

    await waitFor(() => {
      const nodes = useCanvasStore.getState().document?.nodes ?? [];
      expect(nodes).toHaveLength(1);
    });
    const node = useCanvasStore.getState().document!.nodes[0]!;
    expect(node.type).toBe("terminal");
    expect(node.title).toBe("重构保存队列");
    if (node.data.kind !== "terminal") throw new Error("not a terminal node");
    expect(node.data.cwd).toBe("/repo/apps/web");
    expect(node.data.agent?.id).toBe("claude");
    // 启动行带 `--resume <sessionId>`，并交给 pendingLaunch 敲进 shell
    expect(node.data.agent?.initialCommand).toContain("--resume");
    expect(node.data.agent?.initialCommand).toContain(row.sessionId);
    expect(node.data.agent?.pendingLaunch?.after).toEqual([]);
    expect(useCanvasStore.getState().panels.palette).toBe(false);
    expect(container).toBeTruthy();
  });

  it("索引为空时不渲染这一组", async () => {
    conversations.mockResolvedValue([]);
    renderPalette();
    await waitFor(() => expect(conversations).toHaveBeenCalled());
    expect(screen.queryByText("重构保存队列")).toBeNull();
  });
});

describe("暂时下线的功能（#295）", () => {
  it("命令面板里没有定时计划、工作流与活动卡片", async () => {
    renderPalette();
    // 新建菜单的其余项照常在：先等到它，再断言那三项不在。
    expect(await screen.findByText("新建便签")).toBeTruthy();
    for (const label of ["新建定时计划", "工作流", "新建活动卡片"])
      expect(screen.queryByText(label)).toBeNull();
  });
});

/**
 * 键盘中枢（设计系统 §8.3 / §11.2）：开关没有动画，快捷键是 `Kbd`，没输入时「最近」
 * 置顶并带 ⌘1–⌘5，输入后 ⌘N 运行当前排在前面的行，不关面板的命令运行后画对勾 800ms。
 */
describe("命令面板是键盘中枢", () => {
  const row = (label: string) =>
    screen.getByText(label).closest("[cmdk-item]") as HTMLElement;
  const input = () => screen.getByPlaceholderText("搜索");

  it("没有开关动画：内容不带 animate-in / zoom 类，带 data-instant，遮罩也即时", async () => {
    renderPalette();
    await screen.findByText("新建便签");
    const content = window.document.querySelector(
      '[data-slot="dialog-content"]',
    ) as HTMLElement;
    expect(content.dataset.instant).toBeDefined();
    expect(content.className).not.toMatch(/animate-in|zoom-in|slide-in/);
    expect(window.document.body.innerHTML).not.toMatch(/animate-in|zoom-in-95/);
  });

  it("每条命令的快捷键渲染成 Kbd，格式与命令表一致", async () => {
    renderPalette();
    await screen.findByText("新建便签");
    const settings = row("设置");
    const kbd = settings.querySelector("kbd");
    expect(kbd?.textContent).toBe(commandKeysLabel("app.settings"));
    expect(settings.querySelector('[data-slot="command-shortcut"]')).toBe(kbd);
  });

  it("历史对话的目录名和时间是文字，不是 Kbd", async () => {
    renderPalette();
    const dir = await screen.findByText("web");
    expect(dir.closest("kbd")).toBeNull();
    expect(row("重构保存队列").querySelectorAll("kbd")).toHaveLength(0);
  });

  it("运行后关面板的命令：点「设置」面板关、设置开", async () => {
    renderPalette();
    await screen.findByText("新建便签");
    fireEvent.click(row("设置"));
    expect(useCanvasStore.getState().panels.palette).toBe(false);
    expect(useCanvasStore.getState().panels.settings).toBe(true);
    useCanvasStore.getState().setPanel("settings", false);
  });

  it("不关面板的命令运行后项尾画出对勾，800ms 后恢复快捷键", async () => {
    renderPalette();
    await screen.findByText("新建便签");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const zoom = row("放大");
    expect(zoom.querySelector('[data-slot="spinner"]')).toBeNull();
    act(() => zoom.click());
    expect(useCanvasStore.getState().panels.palette).toBe(true);
    const mark = zoom.querySelector('[data-slot="spinner"]');
    expect(mark?.getAttribute("data-state")).toBe("done");
    expect(mark?.querySelector("path")?.getAttribute("class")).toContain(
      "anim-check-draw",
    );
    expect(zoom.querySelector("kbd")).toBeNull();
    act(() => void vi.advanceTimersByTime(RAN_MARK_MS));
    expect(zoom.querySelector('[data-slot="spinner"]')).toBeNull();
    expect(zoom.querySelector("kbd")?.textContent).toBe(
      commandKeysLabel("canvas.zoomIn"),
    );
  });

  it("运行过的命令进「最近」，下次打开置顶并带 ⌘1–⌘5，主列表不再重复", async () => {
    localStorage.setItem(
      "armadra.palette.recent",
      JSON.stringify(["cmd:canvas.zoomOut", "cmd:app.settings"]),
    );
    renderPalette();
    await screen.findByText("新建便签");
    expect(screen.getByText("最近")).toBeTruthy();
    expect(screen.getAllByText("缩小")).toHaveLength(1);
    expect(screen.getAllByText("设置")).toHaveLength(1);
    const rows = [...window.document.querySelectorAll("[cmdk-item]")];
    expect(rows[0]?.textContent).toContain("缩小");
    expect(rows[0]?.querySelector("kbd")?.textContent).toBe("Ctrl+1");
    expect(rows[1]?.textContent).toContain("设置");
    expect(rows[1]?.querySelector("kbd")?.textContent).toBe("Ctrl+2");
  });

  it("⌘N 运行排在第 N 位的行（没输入时是最近的第 N 项）", async () => {
    localStorage.setItem(
      "armadra.palette.recent",
      JSON.stringify(["cmd:canvas.zoomOut", "cmd:app.settings"]),
    );
    renderPalette();
    await screen.findByText("新建便签");
    fireEvent.keyDown(input(), { key: "2", ctrlKey: true });
    expect(useCanvasStore.getState().panels.settings).toBe(true);
    expect(useCanvasStore.getState().panels.palette).toBe(false);
    useCanvasStore.getState().setPanel("settings", false);
    // 记进最近：设置在最前
    expect(JSON.parse(localStorage.getItem("armadra.palette.recent")!)[0]).toBe(
      "cmd:app.settings",
    );
  });

  it("输入之后「最近」退场，⌘1 运行 cmdk 排出来的第一行", async () => {
    localStorage.setItem(
      "armadra.palette.recent",
      JSON.stringify(["cmd:canvas.zoomOut"]),
    );
    renderPalette();
    await screen.findByText("新建便签");
    fireEvent.change(input(), { target: { value: "放大" } });
    await waitFor(() => expect(screen.queryByText("最近")).toBeNull());
    fireEvent.keyDown(input(), { key: "1", ctrlKey: true });
    const zoom = row("放大");
    expect(zoom.querySelector('[data-state="done"]')).not.toBeNull();
    expect(useCanvasStore.getState().panels.palette).toBe(true);
  });

  it("面板关掉再开，查询词和对勾都清掉", async () => {
    const view = renderPalette();
    await screen.findByText("新建便签");
    fireEvent.change(input(), { target: { value: "放大" } });
    act(() => useCanvasStore.getState().setPanel("palette", false));
    act(() => useCanvasStore.getState().setPanel("palette", true));
    expect((input() as HTMLInputElement).value).toBe("");
    expect(view.container).toBeTruthy();
  });
});

/** 内容搜索（#767）：画布、节点、白板内容、设置在 ⌘K 里也找得到。 */
describe("命令面板里的内容搜索", () => {
  const OTHER_BOARD = "019ff7d1-0d12-7421-833d-2c5e8d64ed31";
  const input = () => screen.getByPlaceholderText("搜索");
  const rowOf = (text: string) =>
    screen.getByText(text).closest("[cmdk-item]") as HTMLElement;
  const stickyNode = (index: number, title: string) =>
    ({
      id: `019ff7d1-0d12-7421-833d-${String(index).padStart(12, "0")}`,
      boardId: BOARD_ID,
      type: "sticky",
      title,
      color: "#5B5BD6",
      position: { x: 0, y: 0 },
      labels: [],
      note: "",
      data: { kind: "sticky", content: "" },
      createdAt: timestamp,
      updatedAt: timestamp,
    }) as BoardDocument["nodes"][number];

  beforeEach(() => {
    useCanvasStore.setState({
      boards: [
        { id: BOARD_ID, name: "Default", sortOrder: 0 },
        { id: OTHER_BOARD, name: "画布 3", sortOrder: 1 },
      ],
      document: {
        ...document,
        nodes: [
          ...Array.from({ length: 60 }, (_, index) =>
            stickyNode(index + 1, `便签 ${index + 1}`),
          ),
          stickyNode(100, "发布清单"),
        ],
      },
    });
  });

  it("没输入时除了最近、新建、命令，还带出画布与当前画布的节点", async () => {
    renderPalette();
    expect(await screen.findByText("画布")).toBeTruthy();
    expect(screen.getByText("节点")).toBeTruthy();
    // 没输入时它仍是命令面板：不列工作空间
    expect(screen.queryByText("工作空间")).toBeNull();
    const board = rowOf("画布 3");
    expect(board.querySelector("svg")).not.toBeNull();
    // 右对齐的次级标签：画布所在的工作空间
    expect(board.querySelector('[data-slot="command-meta"]')?.textContent).toBe(
      "repo",
    );
  });

  it("当前画布超过 50 个节点时，靠后的节点也搜得到", async () => {
    renderPalette();
    fireEvent.change(input(), { target: { value: "发布清单" } });
    const row = await screen.findByText("发布清单");
    expect(row.closest("[cmdk-item]")).not.toBeNull();
  });

  it("选中一个节点：选中并居中，面板关闭", async () => {
    renderPalette();
    fireEvent.change(input(), { target: { value: "发布清单" } });
    const centered: string[] = [];
    const onCenter = (event: Event) =>
      centered.push((event as CustomEvent<{ nodeId: string }>).detail.nodeId);
    window.addEventListener("armadra:canvas:center-node", onCenter);
    fireEvent.click(rowOf("发布清单"));
    window.removeEventListener("armadra:canvas:center-node", onCenter);
    expect(useCanvasStore.getState().panels.palette).toBe(false);
    expect(useCanvasStore.getState().selectedNodeIds).toEqual([
      "019ff7d1-0d12-7421-833d-000000000100",
    ]);
    expect(centered).toContain("019ff7d1-0d12-7421-833d-000000000100");
  });

  it("选中一块画布：切过去", async () => {
    renderPalette();
    fireEvent.change(input(), { target: { value: "hb" } });
    fireEvent.click(await screen.findByText("画布 3"));
    expect(useCanvasStore.getState().boardId).toBe(OTHER_BOARD);
    expect(useCanvasStore.getState().panels.palette).toBe(false);
  });

  it("输入「画布」时画布组排在命令组前，输入「放大」时命令组在前", async () => {
    renderPalette();
    fireEvent.change(input(), { target: { value: "画布" } });
    await screen.findByText("画布 3");
    const headings = () =>
      [...window.document.querySelectorAll("[cmdk-group-heading]")].map(
        (heading) => heading.textContent,
      );
    expect(headings().indexOf("画布")).toBeLessThan(headings().indexOf("命令"));
    fireEvent.change(input(), { target: { value: "放大" } });
    await waitFor(() => expect(headings()[0]).toBe("命令"));
  });

  it("命令也认拼音首字母：fd → 放大", async () => {
    renderPalette();
    fireEvent.change(input(), { target: { value: "fd" } });
    await waitFor(() => {
      const first = window.document.querySelector("[cmdk-item]");
      expect(first?.textContent).toContain("放大");
    });
  });

  it("设置：按页名与行名找，选中后打开设置并停在那一页", async () => {
    renderPalette();
    fireEvent.change(input(), { target: { value: "主题" } });
    const row = (await screen.findAllByText("主题"))
      .map((element) => element.closest("[cmdk-item]"))
      .find((item) => item?.getAttribute("data-value")?.startsWith("setting:"));
    expect(row).toBeTruthy();
    expect(
      screen.getByText("设置", { selector: "[cmdk-group-heading]" }),
    ).toBeTruthy();
    expect(
      row!.querySelector('[data-slot="command-meta"]')?.textContent,
    ).not.toBe("");
    fireEvent.click(row!);
    expect(useCanvasStore.getState().panels.settings).toBe(true);
    expect(useCanvasStore.getState().panels.palette).toBe(false);
    useCanvasStore.getState().setPanel("settings", false);
  });

  it("⌘1 运行输入后排第一的内容行", async () => {
    renderPalette();
    fireEvent.change(input(), { target: { value: "画布 3" } });
    await screen.findByText("画布 3");
    fireEvent.keyDown(input(), { key: "1", ctrlKey: true });
    expect(useCanvasStore.getState().boardId).toBe(OTHER_BOARD);
  });

  it("文件：选中交给编辑器", async () => {
    fileIndex.mockResolvedValue({
      entries: [{ name: "button.tsx", path: "src/ui/button.tsx" }],
      truncated: false,
      scanned: 1,
    });
    renderPalette();
    fireEvent.change(input(), { target: { value: "button" } });
    expect(await screen.findByText("button.tsx")).toBeTruthy();
    expect(screen.getByText("文件")).toBeTruthy();
  });
});
