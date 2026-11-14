import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CanvasNode } from "@armadra/shared";

const store = vi.hoisted(() => ({
  document: { nodes: [] as CanvasNode[] },
  focusNodeId: null as string | null,
  maximized: {} as Record<string, unknown>,
  workspace: { id: "workspace-1", rootPath: "/tmp" } as {
    id: string;
    rootPath: string;
  } | null,
  selectNodes: vi.fn(),
  updateNode: vi.fn(),
  updateNodeData: vi.fn(),
  setCollapsed: vi.fn(),
  maximizeNode: vi.fn(),
  restoreNode: vi.fn(),
  removeNodes: vi.fn(),
  resizeNode: vi.fn(),
  addNode: vi.fn(),
  setPanel: vi.fn(),
}));

vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});
// 历史组件本身有自己的测试；这里只看节点把它挂上、带着哪个工作空间。
vi.mock("@/panels/git/log/LogPage", () => ({
  LogPage: ({ workspaceId }: { workspaceId: string }) => (
    <div data-testid="log-page">{workspaceId}</div>
  ),
}));

import { usePreferencesStore } from "@/app/preferences-store";
import { GitNode } from "./GitNode";

const node = {
  id: "55555555-5555-4555-8555-555555555555",
  boardId: "b1",
  type: "git",
  title: "Git",
  color: "#0a84ff",
  position: { x: 0, y: 0 },
  labels: [],
  note: "",
  data: { kind: "git" },
  createdAt: "2026-11-14T00:00:00.000Z",
  updatedAt: "2026-11-14T00:00:00.000Z",
} as unknown as CanvasNode;

const view = () =>
  render(
    <GitNode
      id={node.id}
      node={node}
      selected={false}
      collapsed={false}
      focused={false}
    />,
  );

beforeEach(() => {
  usePreferencesStore.setState({ locale: "en" });
  store.workspace = { id: "workspace-1", rootPath: "/tmp" };
  store.removeNodes.mockClear();
  store.setPanel.mockClear();
});
afterEach(cleanup);

describe("画布 Git 节点（#927 B4）", () => {
  it("挂的就是侧边栏那个历史组件，带当前工作空间", () => {
    view();
    expect(screen.getByTestId("log-page").textContent).toBe("workspace-1");
  });

  it("停靠到侧边栏：节点收走、底部窗口打开", () => {
    view();
    fireEvent.click(
      screen.getByRole("button", { name: "Dock to the side panel" }),
    );
    expect(store.removeNodes).toHaveBeenCalledWith([node.id]);
    expect(store.setPanel).toHaveBeenCalledWith("scm", "bottom");
  });

  it("没有工作空间时不挂历史组件", () => {
    store.workspace = null;
    view();
    expect(screen.queryByTestId("log-page")).toBeNull();
    expect(screen.getByText("Open a workspace first")).toBeTruthy();
  });
});
