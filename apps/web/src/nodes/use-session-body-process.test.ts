import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TerminalNodeData } from "@armadra/shared";

import { useSessionBodyProcess } from "./use-session-body-process";

const fixture = vi.hoisted(() => ({
  data: {
    kind: "terminal",
    agent: { id: "claude", driver: "terminal", view: "session" },
  } as TerminalNodeData,
  hold: "free" as "free" | "held" | "unknown",
  find: vi.fn(),
  start: vi.fn(),
  updateNodeData: vi.fn(),
}));
vi.mock("@/session", () => ({
  sessionGateway: { find: fixture.find, start: fixture.start },
}));
vi.mock("@/store/canvas-store", () => {
  const state = () => ({
    workspace: { id: "ws", rootPath: "/repo" },
    document: { nodes: [{ id: "node", data: fixture.data }] },
    updateNodeData: fixture.updateNodeData,
  });
  const useCanvasStore = Object.assign(
    (select: (value: ReturnType<typeof state>) => unknown) => select(state()),
    { getState: state },
  );
  return { useCanvasStore };
});
vi.mock("@/agent/launch", () => ({
  agentSessionRequest: (agent: { id: string }) => ({ id: agent.id }),
}));
vi.mock("@/agent/dependency-store", () => ({
  launchHold: () => fixture.hold,
  whenDependenciesKnown: async () => undefined,
}));

beforeEach(() => {
  fixture.hold = "free";
  fixture.find.mockReset().mockResolvedValue(null);
  fixture.start.mockReset().mockResolvedValue({ sessionId: "s1" });
  fixture.updateNodeData.mockReset();
});
afterEach(() => vi.clearAllMocks());

it("asks the core to start the process and type the launch line", async () => {
  renderHook(() => useSessionBodyProcess("node", true));
  await waitFor(() => expect(fixture.start).toHaveBeenCalledTimes(1));
  expect(fixture.start.mock.calls[0]![0]).toMatchObject({
    nodeId: "node",
    launch: true,
    cwd: "/repo",
  });
  await waitFor(() =>
    expect(fixture.updateNodeData).toHaveBeenCalledWith(
      "node",
      { sessionId: "s1", lastExitCode: null },
      { history: "ignore" },
    ),
  );
});

it("only attaches to a live or hibernated session", async () => {
  fixture.find.mockResolvedValue({ state: "running", sessionId: "s0" });
  renderHook(() => useSessionBodyProcess("node", true));
  await waitFor(() => expect(fixture.find).toHaveBeenCalled());
  fixture.find.mockResolvedValue({ state: "hibernated", sessionId: "s0" });
  renderHook(() => useSessionBodyProcess("node2", true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(fixture.start).not.toHaveBeenCalled();
});

it("does nothing for the terminal body, a held node or a pending launch", async () => {
  renderHook(() => useSessionBodyProcess("node", false));
  fixture.hold = "held";
  renderHook(() => useSessionBodyProcess("node", true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(fixture.start).not.toHaveBeenCalled();
});
