import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { SessionSummary, Workspace } from "@armadra/shared";

import { useAgentStatusStore } from "../agent/status-store";
import { useCanvasStore } from "../store/canvas-store";
import { AgentStatusPanel } from "./AgentStatusPanel";

const sessions = vi.fn();

vi.mock("../sources/source-api", () => ({
  sourceApi: () => ({
    sessions: (...args: unknown[]) => sessions(...args),
  }),
}));

const timestamp = "2026-09-04T10:00:00.000Z";
const workspace: Workspace = {
  id: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "repo",
  rootPath: "/repo",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  executionHostId: "",
  lastOpenedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
};

function session(
  partial: Partial<SessionSummary> & { nodeId: string; boardId: string },
): SessionSummary {
  return {
    sessionId: `s-${partial.nodeId}`,
    kind: "terminal",
    title: partial.nodeId,
    cwd: "/repo/apps/web",
    agentId: "claude",
    unread: false,
    updatedAt: timestamp,
    alive: true,
    ...partial,
  };
}

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<AgentStatusPanel onClose={() => {}} />, { wrapper });
}

afterEach(() => cleanup());

beforeEach(() => {
  sessions.mockReset();
  useAgentStatusStore.getState().reset();
  useCanvasStore.setState({
    workspace,
    boards: [
      { id: "board-default", name: "Default", sortOrder: 0 },
      { id: "board-3", name: "画布 3", sortOrder: 1 },
    ],
    boardId: "board-3",
  });
});

describe("AgentStatusPanel", () => {
  it("按画布分区、当前画布在前，普通终端与已退出的 Agent 不列", async () => {
    sessions.mockResolvedValue([
      session({ nodeId: "Agent 1", boardId: "board-default", state: "done" }),
      session({
        nodeId: "Agent 2",
        boardId: "board-default",
        sessionPhase: "start",
      }),
      session({
        nodeId: "MacBookPro.local",
        boardId: "board-default",
        agentId: undefined,
      }),
      session({
        nodeId: "Exited",
        boardId: "board-default",
        sessionPhase: "end",
      }),
      session({ nodeId: "Agent 1 copy", boardId: "board-3", state: "waiting" }),
    ]);

    renderPanel();

    const sections = await screen.findAllByRole("region");
    expect(
      sections.map((section) => section.getAttribute("aria-label")),
    ).toEqual(["画布 3", "默认"]);
    expect(within(sections[0]!).getByText("Agent 1 copy")).toBeTruthy();
    expect(within(sections[0]!).getByText("需要你")).toBeTruthy();
    const second = within(sections[1]!);
    expect(second.getByText("Agent 1")).toBeTruthy();
    expect(second.getByText("Agent 2")).toBeTruthy();
    expect(second.getAllByText("空闲")).toHaveLength(2);
    expect(screen.queryByText("MacBookPro.local")).toBeNull();
    expect(screen.queryByText("Exited")).toBeNull();
    expect(screen.queryByText("未知")).toBeNull();
  });

  it("没有 Agent 时给一句空状态", async () => {
    sessions.mockResolvedValue([
      session({
        nodeId: "MacBookPro.local",
        boardId: "board-default",
        agentId: undefined,
      }),
    ]);
    renderPanel();
    expect(await screen.findByText("没有打开的 Agent")).toBeTruthy();
  });
});
