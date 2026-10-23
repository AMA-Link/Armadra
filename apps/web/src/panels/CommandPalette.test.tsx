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

vi.mock("../api/client", () => ({
  runtimeApi: {
    agents: vi.fn().mockResolvedValue([]),
    settings: vi.fn().mockResolvedValue({ ssh: { hosts: [] } }),
    conversations: (...args: unknown[]) => conversations(...args),
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
  const input = () => screen.getByPlaceholderText("搜索命令");

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
