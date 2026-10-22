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
import { NotificationPanel } from "./NotificationPanel";
import { groupNeeds, type NeedItem } from "./needs";
import { useNeedsStore } from "./needs-store";

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
  publish([]);
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
});
