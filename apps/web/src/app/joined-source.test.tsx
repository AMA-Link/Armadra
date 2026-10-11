import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workspaces: [] as { sourceId: string; workspace: { id: string } }[],
  open: vi.fn(),
  share: undefined as
    | {
        sessions: { workspaceId: string; sessionId: string }[];
        sessionOnly: boolean;
      }
    | undefined,
  openShared: vi.fn(),
}));
vi.mock("./workspaces-query", () => ({
  useWorkspaces: () => ({ data: mocks.workspaces }),
}));
vi.mock("./workspace-actions", () => ({
  useOpenWorkspace: () => mocks.open,
}));
vi.mock("../shared-session/sessions", () => ({
  useSessionShare: () => mocks.share,
  useSharedSessionView: (
    select: (state: { open: typeof mocks.openShared }) => unknown,
  ) => select({ open: mocks.openShared }),
}));

import { useCanvasStore } from "../store/canvas-store";
import { openAfterJoin, pendingJoinOpen } from "../sources/join-intent";
import { JoinedSourceOpener } from "./joined-source";

/** 按链接加入之后打开那个源的工作空间（客户端包 §6）。 */

beforeEach(() => {
  sessionStorage.clear();
  mocks.workspaces = [];
  mocks.open.mockReset();
  mocks.share = undefined;
  mocks.openShared.mockReset();
  localStorage.clear();
});
afterEach(cleanup);

describe("JoinedSourceOpener", () => {
  it("没有待办时什么也不做", () => {
    render(<JoinedSourceOpener />);
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("那个源的工作空间出现了：打开它（当前源随之换）、关设置、清掉待办", () => {
    useCanvasStore.getState().setPanel("settings", true);
    openAfterJoin("src-1");
    const view = render(<JoinedSourceOpener />);
    expect(mocks.open).not.toHaveBeenCalled();
    mocks.workspaces = [
      { sourceId: "other", workspace: { id: "w0" } },
      { sourceId: "src-1", workspace: { id: "w1" } },
    ];
    view.rerender(<JoinedSourceOpener />);
    expect(mocks.open).toHaveBeenCalledWith({ id: "w1" }, "src-1");
    expect(useCanvasStore.getState().panels.settings).toBe(false);
    expect(pendingJoinOpen()).toBeNull();
  });

  it("会话分享的访客没有工作空间：改开那条会话的只读查看页（契约 §71）", () => {
    useCanvasStore.getState().setPanel("settings", true);
    openAfterJoin("src-2");
    const view = render(<JoinedSourceOpener />);
    expect(mocks.openShared).not.toHaveBeenCalled();
    mocks.share = {
      sessions: [{ workspaceId: "w9", sessionId: "s9" }],
      sessionOnly: true,
    };
    view.rerender(<JoinedSourceOpener />);
    expect(mocks.openShared).toHaveBeenCalledWith({
      sourceId: "src-2",
      workspaceId: "w9",
      sessionId: "s9",
    });
    expect(mocks.open).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().panels.settings).toBe(false);
    expect(pendingJoinOpen()).toBeNull();
  });

  it("还有画布的人照旧等工作空间，不开会话页", () => {
    openAfterJoin("src-3");
    mocks.share = {
      sessions: [{ workspaceId: "w9", sessionId: "s9" }],
      sessionOnly: false,
    };
    render(<JoinedSourceOpener />);
    expect(mocks.openShared).not.toHaveBeenCalled();
    expect(pendingJoinOpen()).toBe("src-3");
  });
});
