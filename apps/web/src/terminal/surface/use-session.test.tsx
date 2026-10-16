import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TerminalNodeData } from "@armadra/shared";
import type { SurfaceRefs } from "./refs";
import { useTerminalSession } from "./use-session";

const fixture = vi.hoisted(() => ({
  data: {
    kind: "terminal",
    agent: { id: "claude", driver: "terminal" },
  } as TerminalNodeData,
  workspace: { id: "workspace", rootPath: "/repo" } as {
    id: string;
    rootPath: string;
  } | null,
  listeners: new Set<(state: { workspace: unknown }) => void>(),
  find: vi.fn(),
  start: vi.fn(),
  patch: vi.fn(),
  setSessionId: vi.fn(),
  updateNodeData: vi.fn(),
}));
vi.mock("@/session", () => ({
  sessionGateway: { find: fixture.find, start: fixture.start },
}));
vi.mock("@/store/canvas-store", () => ({
  useCanvasStore: {
    getState: () => ({
      workspace: fixture.workspace,
      document: { nodes: [{ id: "node", data: fixture.data }] },
      updateNodeData: fixture.updateNodeData,
    }),
    subscribe: (listener: (state: { workspace: unknown }) => void) => {
      fixture.listeners.add(listener);
      return () => fixture.listeners.delete(listener);
    },
  },
}));
vi.mock("@/agent/launch", () => ({
  agentSessionRequest: (agent: { id: string }) => ({ id: agent.id }),
}));

function refs(): SurfaceRefs {
  return {
    dataRef: { current: fixture.data },
    freshSessionRef: { current: false },
    shellRef: { current: undefined },
    creatingRef: { current: false },
    launchPhaseRef: { current: "idle" },
  } as unknown as SurfaceRefs;
}

function mount() {
  return renderHook(() =>
    useTerminalSession(refs(), {
      nodeId: "node",
      attempt: 0,
      patch: fixture.patch,
      setSessionId: fixture.setSessionId,
      onHibernated: vi.fn(),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.listeners.clear();
  fixture.workspace = { id: "workspace", rootPath: "/repo" };
  fixture.find.mockResolvedValue(null);
  fixture.start.mockResolvedValue({ sessionId: "session", shell: "/bin/zsh" });
});
afterEach(cleanup);

it("a new agent node creates its session and moves on to connecting", async () => {
  mount();
  await waitFor(() => expect(fixture.start).toHaveBeenCalledTimes(1));
  expect(fixture.start).toHaveBeenCalledWith({
    workspaceId: "workspace",
    nodeId: "node",
    cwd: "/repo",
    agent: { id: "claude" },
  });
  await waitFor(() =>
    expect(fixture.setSessionId).toHaveBeenCalledWith("session"),
  );
  expect(fixture.updateNodeData).toHaveBeenCalledWith(
    "node",
    { sessionId: "session", lastExitCode: null },
    { history: "ignore" },
  );
  expect(fixture.patch).toHaveBeenCalledWith(
    expect.objectContaining({ connection: "connecting" }),
  );
});

it("a rejected create is reported as failed with the reason, not swallowed", async () => {
  fixture.start.mockRejectedValue(new Error("tmux failed: create pane failed"));
  mount();
  await waitFor(() =>
    expect(fixture.patch).toHaveBeenCalledWith({
      connection: "failed",
      error: "tmux failed: create pane failed",
    }),
  );
  expect(fixture.setSessionId).not.toHaveBeenCalled();
});

it("a node mounted before the workspace is known creates once it arrives", async () => {
  fixture.workspace = null;
  mount();
  await waitFor(() => expect(fixture.find).not.toHaveBeenCalled());
  expect(fixture.start).not.toHaveBeenCalled();
  fixture.workspace = { id: "workspace", rootPath: "/repo" };
  act(() => {
    for (const listener of [...fixture.listeners])
      listener({ workspace: fixture.workspace });
  });
  await waitFor(() => expect(fixture.start).toHaveBeenCalledTimes(1));
  expect(fixture.listeners.size).toBe(0);
});
