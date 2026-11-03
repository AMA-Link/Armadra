import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace, WorkspaceSummary } from "@armadra/shared";

import { useCanvasStore } from "@/store/canvas-store";
import { BOARDS_TIMEOUT_MS, navigateTo } from "./navigate";
import type { SearchEntry } from "./index";
import { prepare } from "./match";

const goto = vi.hoisted(() => ({ gotoNode: vi.fn(), gotoItem: vi.fn() }));
vi.mock("@/sidebar/goto-node", () => goto);

const timestamp = "2026-09-05T10:00:00.000Z";
const summary = (id: string, name: string): WorkspaceSummary => ({
  id,
  name,
  rootPath: `/${name}`,
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  executionHostId: "",
  lastOpenedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
  boards: [],
});
const alpha = summary("w1", "alpha");
const beta = summary("w2", "beta");

function entry(partial: Partial<SearchEntry>): SearchEntry {
  return {
    id: "e",
    kind: "node",
    icon: "sticky",
    title: "t",
    detail: "",
    workspaceId: "w1",
    workspaceName: "alpha",
    boardId: "b1",
    boardName: "board",
    targetId: "n1",
    primary: prepare("t"),
    secondary: [],
    ...partial,
  };
}

const board = (id: string) => ({ id, name: id, sortOrder: 0 });

describe("navigateTo", () => {
  const openWorkspace = vi.fn((target: WorkspaceSummary) =>
    // 与 `useOpenWorkspace` 一样：切 store、清掉选中画布。
    {
      useCanvasStore.getState().setWorkspace(target as Workspace);
      useCanvasStore.getState().selectBoard(null);
    },
  );
  const deps = { workspaces: [alpha, beta], openWorkspace };

  beforeEach(() => {
    vi.useFakeTimers();
    useCanvasStore.getState().setWorkspace(alpha as Workspace);
    useCanvasStore.getState().setBoards([board("b1"), board("b2")]);
    useCanvasStore.getState().selectBoard("b1");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("同一工作空间的另一块画布：直接切过去", () => {
    navigateTo(entry({ kind: "board", boardId: "b2", targetId: "b2" }), deps);
    expect(useCanvasStore.getState().boardId).toBe("b2");
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("同一工作空间的节点：交给 gotoNode（它负责切板与居中）", () => {
    navigateTo(entry({ boardId: "b2", targetId: "n9" }), deps);
    expect(useCanvasStore.getState().boardId).toBe("b2");
    expect(goto.gotoNode).toHaveBeenCalledWith("b2", "n9");
  });

  it("白板对象：交给 gotoItem，带 wb: id", () => {
    navigateTo(entry({ kind: "item", targetId: "wb:i1" }), deps);
    expect(goto.gotoItem).toHaveBeenCalledWith("b1", "wb:i1");
    expect(goto.gotoNode).not.toHaveBeenCalled();
  });

  it("别的工作空间：先打开它，等画布列表到位后再选画布、再定位节点", () => {
    navigateTo(
      entry({ workspaceId: "w2", boardId: "c2", targetId: "n7" }),
      deps,
    );
    expect(openWorkspace).toHaveBeenCalledWith(beta);
    expect(useCanvasStore.getState().workspace?.id).toBe("w2");
    // 列表还没来：什么都不该发生
    vi.advanceTimersByTime(100);
    expect(goto.gotoNode).not.toHaveBeenCalled();

    // 列表到位，`use-board-sync` 随后自己选了第一块
    useCanvasStore.getState().setBoards([board("c1"), board("c2")]);
    useCanvasStore.getState().selectBoard("c1");
    // 同步选会被盖掉：目标画布晚一拍才选
    expect(useCanvasStore.getState().boardId).toBe("c1");
    vi.advanceTimersByTime(1);
    expect(useCanvasStore.getState().boardId).toBe("c2");
    expect(goto.gotoNode).toHaveBeenCalledWith("c2", "n7");
  });

  it("别的工作空间的画布：只切画布，不定位节点", () => {
    navigateTo(
      entry({
        kind: "board",
        workspaceId: "w2",
        boardId: "c2",
        targetId: "c2",
      }),
      deps,
    );
    useCanvasStore.getState().setBoards([board("c1"), board("c2")]);
    vi.advanceTimersByTime(1);
    expect(useCanvasStore.getState().boardId).toBe("c2");
    expect(goto.gotoNode).not.toHaveBeenCalled();
  });

  it("工作空间条目：打开它；已经是当前的就什么也不做", () => {
    navigateTo(
      entry({ kind: "workspace", workspaceId: "w2", boardId: "" }),
      deps,
    );
    expect(openWorkspace).toHaveBeenCalledWith(beta);
    openWorkspace.mockClear();
    navigateTo(
      entry({ kind: "workspace", workspaceId: "w2", boardId: "" }),
      deps,
    );
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("不认识的工作空间：不动", () => {
    navigateTo(entry({ workspaceId: "nope" }), deps);
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(goto.gotoNode).not.toHaveBeenCalled();
  });

  it("画布列表一直不来：超时后放弃订阅，之后到位也不再动", () => {
    navigateTo(
      entry({ workspaceId: "w2", boardId: "c2", targetId: "n7" }),
      deps,
    );
    vi.advanceTimersByTime(BOARDS_TIMEOUT_MS + 1);
    useCanvasStore.getState().setBoards([board("c1"), board("c2")]);
    vi.advanceTimersByTime(10);
    expect(goto.gotoNode).not.toHaveBeenCalled();
  });
});
