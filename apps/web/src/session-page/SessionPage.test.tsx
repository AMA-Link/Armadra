import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "@/ui/toast";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { AgentInfo } from "@armadra/shared";

import {
  chooseOption,
  installDomPolyfills,
  TestProviders,
} from "@/app/test-harness";
import type { SessionRow } from "@/agent/sessions";
import { agentNode, document } from "./fixtures";

const api = vi.hoisted(() => ({
  listBoards: vi.fn(),
  loadBoard: vi.fn(),
  sessionBoard: vi.fn(),
  startSession: vi.fn(),
  pasteTerminal: vi.fn(),
  pinSession: vi.fn(),
  unpinSession: vi.fn(),
}));
vi.mock("@/api/client", () => ({
  runtimeApi: api,
  errorCode: (error: unknown) =>
    (error as { code?: string } | null)?.code ?? undefined,
}));

const rows = vi.hoisted(() => ({ current: [] as SessionRow[] }));
vi.mock("@/agent/sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/agent/sessions")>()),
  useSessions: () => ({
    sessions: rows.current,
    isPending: false,
    refresh: () => undefined,
  }),
}));

const agents = vi.hoisted(() => ({ current: [] as AgentInfo[] }));
vi.mock("@/app/use-agents", () => ({
  useEnabledAgents: () => agents.current,
}));
vi.mock("@/acp/api", () => ({ usePrestartOnOpen: () => undefined }));
vi.mock("@/nodes/DriveBadge", () => ({ DriveBadge: () => null }));
vi.mock("@/nodes/DeliveryQueueBadge", () => ({
  DeliveryQueueBadge: () => null,
}));
vi.mock("@/nodes/ContextReadsBadge", () => ({ ContextReadsBadge: () => null }));
vi.mock("@/acp/SessionView", () => ({
  default: (props: {
    nodeId: string;
    readOnly?: boolean;
    sessionId?: string;
  }) => (
    <div
      data-testid="session-view"
      data-node={props.nodeId}
      data-read-only={String(Boolean(props.readOnly))}
      data-session={props.sessionId ?? ""}
    />
  ),
}));
const goto = vi.hoisted(() => vi.fn());
vi.mock("@/sidebar/goto-node", () => ({ gotoNode: goto }));

import { useCanvasStore } from "@/store/canvas-store";
import { initialPanels } from "@/store/canvas/internal";
import { setDefaultDriverForTest } from "@/acp/driver";
import { SessionPageHost } from "./SessionPageHost";
import { useSessionPage } from "./store";

installDomPolyfills();

const claude = {
  id: "claude",
  label: "Claude Code",
  installed: true,
  acp: {
    support: "native",
    program: "claude",
    installed: true,
    resume: "none",
  },
} as unknown as AgentInfo;
const codex = {
  id: "codex",
  label: "Codex",
  installed: true,
} as unknown as AgentInfo;

const SID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  agents.current = [claude, codex];
  rows.current = [];
  goto.mockReset();
  setDefaultDriverForTest("acp");
  // 侧栏收起：会话页自带列表（侧栏停靠时列表在侧栏里，见下面「列表的位置」）。
  useCanvasStore.setState({
    workspace: { id: "w1", rootPath: "/repo", name: "repo" },
    panels: { ...initialPanels, sidebar: "collapsed" },
  } as never);
  useSessionPage.setState({
    open: true,
    selectedNodeId: null,
    starting: [],
    creating: false,
  });
  api.listBoards.mockReset().mockResolvedValue([{ id: "b1", name: "Main" }]);
  api.sessionBoard.mockReset().mockResolvedValue({ boardId: "b2" });
  api.loadBoard.mockReset().mockImplementation(async (_w, id: string) =>
    id === "b1"
      ? document("b1", [
          agentNode("canvas-acp", "b1", { title: "Planner", driver: "acp" }),
        ])
      : document("b2", [
          agentNode("term", "b2", {
            title: "Shell agent",
            agent: "codex",
            sessionId: SID,
          }),
        ]),
  );
  api.startSession.mockReset();
  api.pasteTerminal.mockReset().mockResolvedValue(undefined);
  api.pinSession.mockReset().mockResolvedValue({
    fromBoardId: "b2",
    toBoardId: "b1",
    nodeIds: ["term"],
  });
  api.unpinSession.mockReset().mockResolvedValue({
    fromBoardId: "b1",
    toBoardId: "b2",
    nodeIds: ["canvas-acp"],
  });
});
afterEach(() => {
  cleanup();
  useSessionPage.setState({ open: false, selectedNodeId: null, starting: [] });
});

function mount() {
  return render(
    <TestProviders>
      <SessionPageHost />
    </TestProviders>,
  );
}

describe("SessionPage", () => {
  it("没打开时什么也不画", () => {
    useSessionPage.setState({ open: false });
    const { container } = mount();
    expect(container.querySelector('[data-slot="session-page"]')).toBeNull();
  });

  it("没选中时右侧是空态，列表里有两块板上的会话", async () => {
    mount();
    expect(await screen.findByText("选择一个会话")).toBeTruthy();
    expect(await screen.findByText("Planner")).toBeTruthy();
    expect(screen.getByText("Shell agent")).toBeTruthy();
    // 会话板标「会话」，画布标板名
    expect(screen.getByText("Main")).toBeTruthy();
    expect(
      within(screen.getByRole("navigation")).getAllByText("会话").length,
    ).toBeGreaterThan(0);
  });

  it("选 ACP 会话：会话视图接管，画布上的会话可以定位", async () => {
    mount();
    fireEvent.click(await screen.findByText("Planner"));
    const view = await screen.findByTestId("session-view");
    expect(view.dataset.node).toBe("canvas-acp");
    expect(view.dataset.readOnly).toBe("false");
    // 工具簇是一整列：正文与头部一样让开它（#1084）。
    expect(view.closest(".pr-16")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "在画布上定位" }));
    expect(goto).toHaveBeenCalledWith("b1", "canvas-acp");
    expect(useSessionPage.getState().open).toBe(false);
  });

  it("终端驱动：只读会话内容 + 输入行 pasteTerminal；会话板上的没有定位", async () => {
    mount();
    fireEvent.click(await screen.findByText("Shell agent"));
    const view = await screen.findByTestId("session-view");
    expect(view.dataset).toMatchObject({ readOnly: "true", session: SID });
    expect(screen.queryByRole("button", { name: "在画布上定位" })).toBeNull();

    const input = screen.getByRole("textbox", { name: "消息" });
    fireEvent.change(input, { target: { value: "继续" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() =>
      expect(api.pasteTerminal).toHaveBeenCalledWith(SID, "继续", true),
    );
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(""));
  });

  it("会话板上的会话钉到所选画板；画布上的会话可以收回", async () => {
    mount();
    fireEvent.click(await screen.findByText("Shell agent"));
    const pin = await screen.findByRole("button", { name: "钉到画布" });
    fireEvent.pointerDown(pin, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Main" }));
    await waitFor(() =>
      expect(api.pinSession).toHaveBeenCalledWith("w1", "term", "b1"),
    );

    fireEvent.click(await screen.findByText("Planner"));
    expect(screen.queryByRole("button", { name: "钉到画布" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "收回到会话页" }));
    await waitFor(() =>
      expect(api.unpinSession).toHaveBeenCalledWith("w1", "canvas-acp"),
    );
  });

  it("收回失败：连着非会话节点有专门的提示", async () => {
    api.unpinSession.mockRejectedValue({ code: "session_has_other_links" });
    const error = vi.spyOn(toast, "error");
    mount();
    fireEvent.click(await screen.findByText("Planner"));
    fireEvent.click(screen.getByRole("button", { name: "收回到会话页" }));
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("这组会话连着别的节点，先断开那条线"),
    );
    error.mockRestore();
  });

  it("新建会话：按所选 Agent 与驱动调用 startSession，并立即选中、先画出来", async () => {
    api.startSession.mockResolvedValue({
      nodeId: "fresh",
      boardId: "b2",
      title: "Codex 1",
    });
    mount();
    await screen.findByText("Planner");
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    const dialog = await screen.findByRole("dialog");
    // Claude 装了 ACP 适配器：默认 ACP；换成 Codex 后 ACP 不可选，落到终端
    expect(
      within(dialog)
        .getByRole("radio", { name: "ACP" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await chooseOption(
      within(dialog).getByRole("combobox", { name: "Agent" }),
      "Codex",
    );
    expect(within(dialog).getByRole("radio", { name: "ACP" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));

    await waitFor(() =>
      expect(api.startSession).toHaveBeenCalledWith({
        workspaceId: "w1",
        agentId: "codex",
        driver: "terminal",
      }),
    );
    await waitFor(() =>
      expect(useSessionPage.getState().selectedNodeId).toBe("fresh"),
    );
    // 文档里还没有它，列表与面板已经有了
    expect((await screen.findAllByText("Codex 1")).length).toBe(2);
    expect(screen.getAllByText("启动中").length).toBeGreaterThan(0);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("新建失败：提示且对话框保留", async () => {
    api.startSession.mockRejectedValue(new Error("boom"));
    mount();
    await screen.findByText("Planner");
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() => expect(api.startSession).toHaveBeenCalled());
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(useSessionPage.getState().selectedNodeId).toBeNull();
  });

  it("会话多于 6 条才出现过滤框", async () => {
    api.loadBoard.mockImplementation(async (_w, id: string) =>
      id === "b1"
        ? document(
            "b1",
            Array.from({ length: 7 }, (_, i) =>
              agentNode(`n${i}`, "b1", { title: `Agent ${i}` }),
            ),
          )
        : document("b2", []),
    );
    mount();
    await screen.findByText("Agent 0");
    const filter = screen.getByRole("textbox", { name: "过滤" });
    fireEvent.change(filter, { target: { value: "Agent 3" } });
    expect(screen.queryByText("Agent 0")).toBeNull();
    expect(screen.getByText("Agent 3")).toBeTruthy();
  });

  it("Escape 关闭页面；关闭按钮同样", async () => {
    mount();
    await screen.findByText("Planner");
    fireEvent.keyDown(window.document.body, { key: "Escape" });
    expect(useSessionPage.getState().open).toBe(false);
  });
});

describe("换工作空间", () => {
  it("关掉页面并清空选中", async () => {
    useSessionPage.setState({ selectedNodeId: "x" });
    mount();
    await screen.findByText("Planner");
    act(() => {
      useCanvasStore.setState({ workspace: { id: "w2" } } as never);
    });
    expect(useSessionPage.getState()).toMatchObject({
      open: false,
      selectedNodeId: null,
    });
  });
});

describe("列表的位置（#1084）", () => {
  it("侧栏停靠展开时页面不带列表，只剩详情；收起后列表回到页面", async () => {
    useCanvasStore.setState({
      panels: { ...initialPanels, sidebar: "open" },
    } as never);
    const { container } = mount();
    expect(await screen.findByText("选择一个会话")).toBeTruthy();
    expect(container.querySelector('[data-slot="session-list"]')).toBeNull();
    act(() => {
      useCanvasStore.setState({
        panels: { ...initialPanels, sidebar: "collapsed" },
      } as never);
    });
    expect(await screen.findByText("Planner")).toBeTruthy();
  });

  it("「新建会话」的开关在 store 里：侧栏的列表也能打开对话框", async () => {
    useCanvasStore.setState({
      panels: { ...initialPanels, sidebar: "open" },
    } as never);
    mount();
    await screen.findByText("选择一个会话");
    act(() => useSessionPage.getState().setCreating(true));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });
});

describe("换画布（#1084）", () => {
  it("当前画布一变就关掉页面，选中保留", async () => {
    useCanvasStore.setState({ boardId: "b1" } as never);
    useSessionPage.setState({ selectedNodeId: "x" });
    mount();
    await screen.findByText("Planner");
    act(() => {
      useCanvasStore.setState({ boardId: "b3" } as never);
    });
    expect(useSessionPage.getState()).toMatchObject({
      open: false,
      selectedNodeId: "x",
    });
  });
});

describe("useSessionPage", () => {
  it("show 带选中，toggle 切换", () => {
    const store = useSessionPage.getState();
    store.close();
    useSessionPage.getState().show("n1");
    expect(useSessionPage.getState()).toMatchObject({
      open: true,
      selectedNodeId: "n1",
    });
    useSessionPage.getState().toggle();
    expect(useSessionPage.getState().open).toBe(false);
  });
});
