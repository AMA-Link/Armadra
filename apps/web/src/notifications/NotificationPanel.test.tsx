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
  within,
} from "@testing-library/react";

import {
  SKELETON_DELAY_MS,
  SKELETON_MIN_VISIBLE_MS,
} from "../loading/use-skeleton-phase";
import { SKELETON_ROW } from "@/ui/skeletons";
import { usePreferencesStore } from "../app/preferences-store";
import { useSubagentStore } from "../agent/subagent-store";
import { scoped } from "../sources/scope";
import { NotificationPanel } from "./NotificationPanel";
import { groupNeeds, type NeedItem } from "./needs";
import { selectNeedCount, useNeedsStore } from "./needs-store";
import { useCanvasStore } from "../store/canvas-store";

const devices = vi.hoisted(() => ({
  markEndorsementsRead: vi.fn(async () => undefined),
}));
vi.mock("../api/devices", () => ({
  ENDORSEMENTS_QUERY_KEY: ["endorsements"],
  devicesApi: devices,
}));

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

const at = "2026-10-17T10:00:00.000Z";
const item = (partial: Partial<NeedItem> & { nodeId: string }): NeedItem => ({
  key: `${partial.workspaceId ?? "w1"}:${partial.nodeId}`,
  workspaceId: "w1",
  boardId: "b1",
  title: partial.nodeId,
  need: "input",
  updatedAt: at,
  ...partial,
});
const layout = {
  workspaces: [
    { id: "w1", name: "前端", boards: [{ id: "b1", name: "画布 1" }] },
    { id: "w2", name: "后端", boards: [{ id: "b3", name: "画布 3" }] },
  ],
};

function publish(items: NeedItem[]) {
  useNeedsStore.getState().set(items, groupNeeds(items, layout));
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  useSubagentStore.getState().reset();
  publish([]);
  useNeedsStore.setState({ host: [], hostSynced: false });
  devices.markEndorsementsRead.mockClear();
});
afterEach(cleanup);

describe("NotificationPanel", () => {
  it("三层分组各带计数，每个节点写明要人做什么", () => {
    publish([
      item({ nodeId: "claude", need: "approval" }),
      item({ nodeId: "codex", need: "error" }),
      item({ nodeId: "gemini", workspaceId: "w2", boardId: "b3" }),
    ]);
    render(<NotificationPanel onClose={() => {}} />);

    const workspaces = screen.getAllByRole("region", { name: /前端|后端/ });
    expect(workspaces).toHaveLength(2);
    const first = within(workspaces[0]!);
    expect(first.getByText("前端").nextSibling?.textContent).toBe("2");
    expect(first.getByText("画布 1").nextSibling?.textContent).toBe("2");
    expect(first.getByText("等待审批")).toBeTruthy();
    expect(first.getByText("出错")).toBeTruthy();
    const second = within(workspaces[1]!);
    expect(second.getByText("等待回答")).toBeTruthy();
  });

  it("没有要处理的事时只给一句空状态", () => {
    render(<NotificationPanel onClose={() => {}} />);
    expect(screen.getByText("没有需要处理的事")).toBeTruthy();
  });

  it("首批数据还没同步时不显示空状态，而是骨架（同步完才判空）", () => {
    vi.useFakeTimers();
    try {
      useNeedsStore.setState({ synced: false });
      render(<NotificationPanel onClose={() => {}} />);
      expect(screen.queryByText("没有需要处理的事")).toBeNull();
      act(() => void vi.advanceTimersByTime(SKELETON_DELAY_MS));
      expect(
        document.querySelector("[data-slot=notifications-skeleton]"),
      ).toBeTruthy();
      // 骨架里的行高与真实节点行同一档（tall，h-10）。
      expect(
        document.querySelector(`[data-slot=skeleton-row].${SKELETON_ROW.tall}`),
      ).toBeTruthy();
      act(() => useNeedsStore.getState().set([], [], true));
      act(() => void vi.advanceTimersByTime(SKELETON_MIN_VISIBLE_MS));
      expect(screen.getByText("没有需要处理的事")).toBeTruthy();
      expect(
        document.querySelector("[data-slot=notifications-skeleton]"),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("点一项：收起面板并切到那个工作空间、画布与节点", () => {
    const open = vi.fn();
    const onClose = vi.fn();
    useNeedsStore.setState({ open });
    const target = item({ nodeId: "gemini", workspaceId: "w2", boardId: "b3" });
    publish([target]);
    render(<NotificationPanel onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /gemini/ }));
    expect(onClose).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(target);
  });

  it("处理完的项一更新就消失", () => {
    publish([item({ nodeId: "claude", need: "approval" })]);
    render(<NotificationPanel onClose={() => {}} />);
    expect(screen.getByText("claude")).toBeTruthy();
    cleanup();
    publish([]);
    render(<NotificationPanel onClose={() => {}} />);
    expect(screen.queryByText("claude")).toBeNull();
  });

  it("行是 Item：标题、状态胶囊、等宽的相对时间；不再是整行 Button", () => {
    publish([item({ nodeId: "claude", need: "approval", sessionId: "s1" })]);
    const { container } = render(<NotificationPanel onClose={() => {}} />);
    const row = container.querySelector("[data-need-row]")!;
    expect(row.matches("[data-slot=item]")).toBe(true);
    expect(row.querySelector("[data-slot=status-pill]")?.textContent).toBe(
      "等待审批",
    );
    expect(row.querySelector("[data-numeric]")?.className).toContain(
      "font-mono",
    );
    // 主区域是一个按钮，行本身不是 Button
    expect(row.matches("[data-slot=button]")).toBe(false);
  });

  it("⋯ 常显，不靠悬停才出现", () => {
    publish([item({ nodeId: "claude", sessionId: "s1" })]);
    render(<NotificationPanel onClose={() => {}} />);
    const more = screen.getByRole("button", { name: "更多" });
    expect(more.className).not.toContain("opacity-0");
  });

  it("↑↓ 在行之间移动，Home / End 到头尾；只有一个 Tab 停靠点", () => {
    publish([
      item({ nodeId: "a" }),
      item({ nodeId: "b" }),
      item({ nodeId: "c" }),
    ]);
    const { container } = render(<NotificationPanel onClose={() => {}} />);
    const rows = [
      ...container.querySelectorAll<HTMLElement>("[data-roving-item]"),
    ];
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.tabIndex === 0)).toHaveLength(1);
    rows[0]!.focus();
    fireEvent.keyDown(rows[0]!, { key: "ArrowDown" });
    expect(window.document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1]!, { key: "End" });
    expect(window.document.activeElement).toBe(rows[2]);
    fireEvent.keyDown(rows[2]!, { key: "ArrowUp" });
    expect(window.document.activeElement).toBe(rows[1]);
  });

  it("有下级（子代理卡片）的节点：⋯ 之前渲染 AgentTree sm，汇总进 aria-label；没有下级的行不渲染", () => {
    useSubagentStore.setState({
      cards: {
        [scoped("claude")]: [
          {
            id: "k1",
            parentId: "claude",
            taskLabel: "评审改动",
            startedAt: 1,
            state: "working",
          },
          {
            id: "k2",
            parentId: "claude",
            taskLabel: "补测试",
            startedAt: 2,
            state: "done",
          },
        ],
      },
    });
    publish([
      item({ nodeId: "claude", need: "approval", sessionId: "s1" }),
      item({ nodeId: "codex", need: "input" }),
    ]);
    const { container } = render(<NotificationPanel onClose={() => {}} />);
    const rows = container.querySelectorAll("[data-need-row]");
    expect(rows).toHaveLength(2);
    const withTree = rows[0]!;
    const tree = withTree.querySelector(
      "[data-slot=agent-tree][data-size=sm]",
    )!;
    expect(tree).toBeTruthy();
    expect(tree.getAttribute("aria-label")).toBe(
      "2 个子 Agent，1 个运行中，1 个已完成",
    );
    expect(withTree.getAttribute("data-tree")).toBe("true");
    // 树在胶囊之后、⋯ 之前
    const order = [
      ...withTree.querySelectorAll(
        "[data-slot=status-pill], [data-slot=agent-tree], [data-slot=dropdown-menu-trigger]",
      ),
    ].map(
      (node) =>
        node.getAttribute("data-slot") ?? node.getAttribute("aria-label"),
    );
    expect(order).toEqual([
      "status-pill",
      "agent-tree",
      "dropdown-menu-trigger",
    ]);
    // 树是一个 Tab 停靠点
    expect((tree as HTMLElement).tabIndex).toBe(0);
    // 没有下级的行不渲染
    expect(rows[1]!.querySelector("[data-slot=agent-tree]")).toBeNull();
    expect(rows[1]!.getAttribute("data-tree")).toBeNull();
  });

  it("本机的背书在各工作空间之前单列一组，计入铃铛；点开标已读并打开「设备」页", async () => {
    const endorsement = {
      id: "e1",
      deviceId: "dev_new",
      principalId: "p_member",
      principalName: "李四",
      deviceLabel: "iPad",
      devicePlatform: "ios",
      endorserDeviceId: "dev_browser",
      endorserPrincipalId: "p_owner",
      endorserLabel: "Chrome",
      createdAtMs: Date.parse(at),
    };
    publish([item({ nodeId: "claude", need: "approval" })]);
    useNeedsStore.getState().setHost([endorsement]);
    expect(selectNeedCount(useNeedsStore.getState())).toBe(2);
    const onClose = vi.fn();
    render(<NotificationPanel onClose={onClose} />);
    const regions = screen.getAllByRole("region");
    expect(regions[0]!.getAttribute("aria-label")).toBe("本机");
    const host = within(regions[0]!);
    expect(host.getByText("本机").nextSibling?.textContent).toBe("1");
    expect(host.getByText("设备背书")).toBeTruthy();
    fireEvent.click(
      host.getByRole("button", { name: /Chrome 放行了 李四 的 iPad/ }),
    );
    expect(onClose).toHaveBeenCalled();
    expect(devices.markEndorsementsRead).toHaveBeenCalledWith(["e1"]);
    expect(usePreferencesStore.getState().lastSettingsSection).toBe("devices");
    expect(useCanvasStore.getState().panels.settings).toBe(true);
    await act(async () => {});
    expect(useNeedsStore.getState().host).toEqual([]);
  });

  it("只有本机条目时不显示空状态", () => {
    useNeedsStore.getState().setHost([
      {
        id: "e2",
        deviceId: "d",
        principalId: "p",
        principalName: "",
        deviceLabel: "",
        devicePlatform: "",
        endorserDeviceId: "abcdef0123",
        endorserPrincipalId: "",
        endorserLabel: "",
        createdAtMs: 1,
      },
    ]);
    render(<NotificationPanel onClose={() => {}} />);
    expect(screen.queryByText("没有需要处理的事")).toBeNull();
    expect(screen.getByText("abcdef01 放行了 p 的 —")).toBeTruthy();
  });
});
