import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import type { SessionRow } from "@/agent/sessions";
import { agentNode, document, row, supervises } from "./fixtures";

const api = vi.hoisted(() => ({
  listBoards: vi.fn(),
  loadBoard: vi.fn(),
  sessionBoard: vi.fn(),
}));
vi.mock("@/api/client", () => ({ runtimeApi: api }));

const rows = vi.hoisted(() => ({ current: [] as SessionRow[] }));
vi.mock("@/agent/sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/agent/sessions")>()),
  useSessions: () => ({
    sessions: rows.current,
    isPending: false,
    refresh: () => undefined,
  }),
}));

import { dispatchWorkspaceEvent } from "@/api/events";
import { useSessionPage } from "./store";
import { useWorkspaceAgentSessions } from "./use-agent-sessions";

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const boards = [{ id: "b1", name: "Main" }];

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  rows.current = [];
  useSessionPage.setState({ starting: [], selectedNodeId: null, open: false });
  api.listBoards.mockReset().mockResolvedValue(boards);
  api.sessionBoard.mockReset().mockResolvedValue({ boardId: "b2" });
  api.loadBoard
    .mockReset()
    .mockImplementation(async (_w, id: string) =>
      id === "b1"
        ? document(
            "b1",
            [agentNode("lead", "b1"), agentNode("worker", "b1")],
            [supervises("b1", "lead", "worker")],
          )
        : document("b2", [agentNode("solo", "b2", { driver: "acp" })]),
    );
});
afterEach(cleanup);

describe("useWorkspaceAgentSessions", () => {
  it("合并全部画布与会话板：树、会话板标注、会话行", async () => {
    rows.current = [row("lead", { state: "working" })];
    const { result } = renderHook(() => useWorkspaceAgentSessions("w1"), {
      wrapper,
    });
    await waitFor(() => expect(result.current.items).toHaveLength(3));
    const byId = new Map(result.current.items.map((i) => [i.nodeId, i]));
    expect(byId.get("solo")).toMatchObject({
      onSessionBoard: true,
      boardName: "会话",
    });
    expect(byId.get("lead")?.session?.state).toBe("working");
    expect(byId.get("worker")?.parentId).toBe("lead");
    const lead = result.current.tree.find((n) => n.item.nodeId === "lead");
    expect(lead?.children.map((c) => c.item.nodeId)).toEqual(["worker"]);
    expect(result.current.loading).toBe(false);
  });

  it("会话板还没建过时只有画布上的会话", async () => {
    api.sessionBoard.mockResolvedValue({ boardId: null });
    const { result } = renderHook(() => useWorkspaceAgentSessions("w1"), {
      wrapper,
    });
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(api.loadBoard).not.toHaveBeenCalledWith("w1", "b2");
  });

  it("board.changed 只重取那一块板（自己存的同版本不取）", async () => {
    const { result } = renderHook(() => useWorkspaceAgentSessions("w1"), {
      wrapper,
    });
    await waitFor(() => expect(result.current.items).toHaveLength(3));
    api.loadBoard.mockClear();

    act(() =>
      dispatchWorkspaceEvent({
        type: "board.changed",
        boardId: "b2",
        updatedAt: "2026-11-26T10:00:00.000Z",
      }),
    );
    expect(api.loadBoard).not.toHaveBeenCalled();

    api.loadBoard.mockResolvedValue(
      document(
        "b2",
        [agentNode("solo", "b2"), agentNode("second", "b2")],
        [],
        "2026-11-26T11:00:00.000Z",
      ),
    );
    act(() =>
      dispatchWorkspaceEvent({
        type: "board.changed",
        boardId: "b2",
        updatedAt: "2026-11-26T11:00:00.000Z",
      }),
    );
    await waitFor(() => expect(result.current.items).toHaveLength(4));
    expect(api.loadBoard).toHaveBeenCalledTimes(1);
    expect(api.loadBoard).toHaveBeenCalledWith("w1", "b2");
  });

  it("没见过的板有变化时重取会话板 id（第一次起会话才建它）", async () => {
    api.sessionBoard.mockResolvedValue({ boardId: null });
    const { result } = renderHook(() => useWorkspaceAgentSessions("w1"), {
      wrapper,
    });
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    api.sessionBoard.mockResolvedValue({ boardId: "b2" });
    act(() =>
      dispatchWorkspaceEvent({
        type: "board.changed",
        boardId: "b2",
        updatedAt: "2026-11-26T11:00:00.000Z",
      }),
    );
    await waitFor(() => expect(result.current.items).toHaveLength(3));
  });

  it("刚新开的会话先出现，refresh 重取", async () => {
    const { result } = renderHook(() => useWorkspaceAgentSessions("w1"), {
      wrapper,
    });
    await waitFor(() => expect(result.current.items).toHaveLength(3));
    act(() =>
      useSessionPage.getState().addStarting({
        nodeId: "fresh",
        boardId: "b2",
        title: "Fresh",
        agentId: "codex",
        driver: "terminal",
      }),
    );
    expect(result.current.items.find((i) => i.nodeId === "fresh")).toBeTruthy();
    api.listBoards.mockClear();
    act(() => result.current.refresh());
    await waitFor(() => expect(api.listBoards).toHaveBeenCalled());
  });
});
