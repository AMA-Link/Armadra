import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Board, Workspace } from "@armadra/shared";

const createBoard = vi.fn();
const listBoards = vi.fn();

vi.mock("../api/client", () => ({
  runtimeApi: {
    createBoard: (...args: unknown[]) => createBoard(...args),
    listBoards: (...args: unknown[]) => listBoards(...args),
  },
}));

import { installDomPolyfills } from "../app/test-harness";
import { sk } from "../sources/scope";
import { useCanvasStore } from "../store/canvas-store";
import { BoardOnly, NoBoards } from "./NoBoards";

installDomPolyfills();
afterEach(cleanup);

const now = new Date().toISOString();
const workspace: Workspace = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "alpha",
  rootPath: "/tmp/alpha",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  executionHostId: "",
  lastOpenedAt: now,
  createdAt: now,
  updatedAt: now,
};

const board: Board = {
  id: "22222222-2222-4222-8222-222222222222",
  workspaceId: workspace.id,
  name: "画布 1",
  sortOrder: 0,
  viewport: { x: 0, y: 0, zoom: 1 },
  whiteboard: "",
  createdAt: now,
  updatedAt: now,
};

function renderWith(boards: Board[] | undefined) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (boards) client.setQueryData(sk("boards", workspace.id), boards);
  return render(
    <QueryClientProvider client={client}>
      <NoBoards />
      <BoardOnly>
        <span>dock</span>
      </BoardOnly>
    </QueryClientProvider>,
  );
}

describe("NoBoards", () => {
  beforeEach(() => {
    createBoard.mockReset();
    listBoards.mockReset().mockResolvedValue([]);
    useCanvasStore.setState({ workspace, boards: [], boardId: null });
  });

  it("工作空间没有画布时显示空状态，并收起 Dock", () => {
    renderWith([]);
    expect(screen.getByText("没有画布")).toBeTruthy();
    expect(screen.queryByText("dock")).toBeNull();
  });

  it("画布列表还没到时不显示，Dock 照常", () => {
    renderWith(undefined);
    expect(screen.queryByText("没有画布")).toBeNull();
    expect(screen.getByText("dock")).toBeTruthy();
    expect(listBoards).not.toHaveBeenCalled();
  });

  it("有画布时不显示", () => {
    useCanvasStore.setState({ boardId: board.id });
    renderWith([board]);
    expect(screen.queryByText("没有画布")).toBeNull();
    expect(screen.getByText("dock")).toBeTruthy();
  });

  it("「新建画布」建一块并切过去", async () => {
    createBoard.mockResolvedValue(board);
    renderWith([]);

    fireEvent.click(screen.getByRole("button", { name: "新建画布" }));

    await waitFor(() =>
      expect(createBoard).toHaveBeenCalledWith(workspace.id, "画布 1"),
    );
    await waitFor(() =>
      expect(useCanvasStore.getState().boardId).toBe(board.id),
    );
  });
});
