import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { BoardDocument, CanvasNode, Workspace } from "@armadra/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

const locate = vi.hoisted(() => vi.fn());
vi.mock("../sidebar/goto-node", () => ({ gotoNode: locate }));

import { installDomPolyfills } from "../app/test-harness";
import { useAgentStatusStore } from "../agent/status-store";
import { initialPanels } from "../store/canvas/internal";
import { useCanvasStore } from "../store/canvas-store";
import { NodeObservationDrawer } from "./NodeObservationDrawer";

installDomPolyfills();
afterEach(() => {
  cleanup();
  locate.mockReset();
  useAgentStatusStore.getState().reset();
  useCanvasStore.setState({
    workspace: null,
    boardId: null,
    document: null,
    selectedNodeIds: [],
    panels: initialPanels,
  });
});

const boardId = "019ff7d1-0d12-7421-833d-2c5e8d64ed30";
const nodeId = "019ff7d1-0d12-7421-833d-2c5e8d64ed31";
const workspaceId = "019ff7d1-0d12-7421-833d-2c5e8d64ed21";

function showCanvas() {
  const node = {
    id: nodeId,
    boardId,
    type: "sticky",
    title: "验收要点",
    parentId: undefined,
    data: { kind: "sticky", content: "" },
  } as CanvasNode;
  useCanvasStore.setState({
    sourceId: "local",
    workspace: { id: workspaceId, name: "demo" } as Workspace,
    boardId,
    document: {
      board: {
        id: boardId,
        workspaceId,
        name: "默认",
        sortOrder: 0,
        viewport: { x: 0, y: 0, zoom: 1 },
        whiteboard: "",
        createdAt: "2026-10-16T00:00:00.000Z",
        updatedAt: "2026-10-16T00:00:00.000Z",
      },
      nodes: [node],
      edges: [],
    } as BoardDocument,
    selectedNodeIds: [],
    panels: { ...initialPanels, observation: "drawer" },
  });
  render(<NodeObservationDrawer />);
}

describe("NodeObservationDrawer", () => {
  it("highlights on row selection and centers only after Locate", () => {
    showCanvas();

    fireEvent.click(screen.getByRole("button", { name: "验收要点" }));
    expect(useCanvasStore.getState().selectedNodeIds).toEqual([nodeId]);
    expect(locate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "定位节点" }));
    expect(locate).toHaveBeenCalledWith(boardId, nodeId);
    expect(useCanvasStore.getState().panels.observation).toBe("closed");
  });

  it("does not show a previous board's nodes while switching canvases", () => {
    showCanvas();
    act(() => {
      useCanvasStore.setState({
        boardId: "019ff7d1-0d12-7421-833d-2c5e8d64ed99",
      });
    });
    expect(screen.queryByRole("button", { name: "验收要点" })).toBeNull();
    // 新画布的文档还没到：不是「没有节点」，空态不能先闪一下。
    expect(screen.queryByText("这张画布还没有节点")).toBeNull();
    expect(document.querySelector("[data-slot=loadable]")).not.toBeNull();
  });

  it("文档到了却没有节点才是空态", () => {
    showCanvas();
    act(() => {
      useCanvasStore.setState({
        document: { ...useCanvasStore.getState().document!, nodes: [] },
      });
    });
    expect(screen.getByText("这张画布还没有节点")).toBeTruthy();
  });

  it("uses the existing failure color and a failure label for an errored Agent", () => {
    showCanvas();
    act(() => {
      const document = useCanvasStore.getState().document!;
      useCanvasStore.setState({
        document: {
          ...document,
          nodes: [
            {
              ...document.nodes[0]!,
              type: "terminal",
              data: { kind: "terminal", agent: { id: "codex" } },
            } as CanvasNode,
          ],
        },
      });
      useAgentStatusStore.setState({
        statuses: {
          [`local:${nodeId}`]: {
            nodeId,
            workspaceId,
            agentId: "codex",
            state: "done",
            unread: false,
            verified: true,
            restored: false,
            errored: true,
            updatedAt: "2026-10-16T00:00:00.000Z",
          },
        },
      });
    });
    expect(screen.getByText("已失败")).toBeTruthy();
  });

  /** S2 / S4：进程已死的审批不再冒充「需要你」；S6：等待回答和审批同一个色调。 */
  function showAgent(partial: Record<string, unknown>) {
    showCanvas();
    act(() => {
      const document = useCanvasStore.getState().document!;
      useCanvasStore.setState({
        document: {
          ...document,
          nodes: [
            {
              ...document.nodes[0]!,
              type: "terminal",
              data: { kind: "terminal", agent: { id: "codex" } },
            } as CanvasNode,
          ],
        },
      });
      useAgentStatusStore.setState({
        statuses: {
          [`local:${nodeId}`]: {
            nodeId,
            workspaceId,
            agentId: "codex",
            unread: false,
            verified: true,
            restored: false,
            updatedAt: "2026-10-16T00:00:00.000Z",
            ...partial,
          },
        },
      });
    });
  }

  it("does not call a dead process's approval 'needs you'", () => {
    showAgent({ state: "blocked", pendingId: "p1", alive: false });
    expect(screen.queryByText("等待审批")).toBeNull();
    expect(screen.getByText("已退出")).toBeTruthy();
  });

  it("draws a question and an approval in the same attention tone", () => {
    showAgent({ state: "waiting" });
    const pill = screen
      .getByText("等待回答")
      .closest("[data-slot=status-pill]");
    expect(pill?.getAttribute("data-tone")).toBe("attention");
  });
});
