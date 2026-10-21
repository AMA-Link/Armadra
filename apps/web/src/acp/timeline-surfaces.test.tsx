import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TerminalNodeData, TimelineItem } from "@armadra/shared";

/**
 * 同一条时间线、三处显示（B7 验收）：画布节点、手机焦点页（同一个节点体，窄屏）、
 * 只读分享页（访客）喂同一组条目，回合区的 DOM 一致。
 */
const api = vi.hoisted(() => ({
  createSession: vi.fn(),
  log: vi.fn(),
  prompt: vi.fn(),
  cancel: vi.fn(),
  setMode: vi.fn(),
  setModel: vi.fn(),
  answerElicitation: vi.fn(),
  switchDriver: vi.fn(),
  answer: vi.fn(),
  drive: vi.fn(),
}));
vi.mock("./api", () => ({ acpApi: api }));
vi.mock("@/store/canvas-store", () => {
  const state = {
    workspace: { id: "w1", rootPath: "/repo" },
    document: null,
    updateNodeData: vi.fn(),
  };
  const useCanvasStore = <T,>(selector: (s: typeof state) => T) =>
    selector(state);
  useCanvasStore.getState = () => state;
  return { useCanvasStore };
});
vi.mock("@/api/events", () => ({
  connectWorkspaceEvents: () => () => undefined,
  onWorkspaceEvent: () => () => undefined,
  onWorkspaceConnection: () => () => undefined,
}));
vi.mock("@/api/client", () => ({
  errorCode: (error: { code?: string } | null) => error?.code,
  RuntimeRequestError: class extends Error {},
  runtimeApi: {},
  clientFor: () => ({}),
}));

import { LOCAL_SOURCE_ID, localSource } from "@/api/source";
import { ReadOnlyTranscript } from "@/shared-session/ReadOnlyTranscript";
import { setTimelineTransportFactory } from "@/timeline/api";
import { resetTimelines } from "@/timeline/sync";
import {
  FakeCore,
  TIMELINE_ID,
  assistant,
  user,
} from "@/timeline/test-support";
import { mockLayout } from "@/timeline/view/test-layout";
import { SessionView } from "./SessionView";

const data: TerminalNodeData = {
  kind: "terminal",
  sessionId: TIMELINE_ID,
  cwd: "/repo",
  agent: { id: "codex", driver: "acp" },
};

function seed(core: FakeCore) {
  const tool: TimelineItem = {
    id: "tool:t1",
    kind: "tool",
    turn: 1,
    ord: 2,
    rev: 0,
    source: "acp",
    at: 1,
    gen: 1,
    toolCallId: "t1",
    toolKind: "execute",
    title: "pnpm test",
    status: "completed",
    locations: [],
    content: [{ type: "text", text: "3 passed" }],
    startedAt: 1,
  };
  core.emit(
    { op: "put", item: user(1, "run the tests") } as never,
    { op: "put", item: tool } as never,
    { op: "put", item: { ...assistant(1, "all green"), ord: 3 } } as never,
    { op: "put", item: user(2, "and lint?") } as never,
    { op: "put", item: assistant(2, "lint is clean") } as never,
  );
}

const turns = () =>
  [...document.querySelectorAll("[data-slot=timeline-turn-section]")].map(
    // Radix 按挂载顺序生成的 id 不算内容。
    (section) => section.innerHTML.replace(/ id="radix-[^"]*"/g, ""),
  );

beforeEach(() => {
  mockLayout();
  api.log.mockResolvedValue({ entries: [], endOffset: 0 });
  api.drive.mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  resetTimelines();
  setTimelineTransportFactory();
  vi.restoreAllMocks();
});

describe("one timeline, three surfaces", () => {
  it("renders the same turns on the canvas node, the phone focus page and the share page", async () => {
    const core = new FakeCore();
    seed(core);
    setTimelineTransportFactory(() => core.transport);

    // 画布节点。
    const canvas = render(<SessionView nodeId="n1" data={data} />);
    await screen.findByText("lint is clean");
    const onCanvas = turns();
    expect(onCanvas.length).toBe(2);
    canvas.unmount();
    resetTimelines();

    // 手机焦点页：同一个节点体，窄屏。
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      ...original(query),
      matches: query.includes("767"),
    })) as typeof window.matchMedia;
    try {
      const phone = render(<SessionView nodeId="n1" data={data} />);
      await screen.findByText("lint is clean");
      expect(turns()).toEqual(onCanvas);
      phone.unmount();
    } finally {
      window.matchMedia = original;
    }
    resetTimelines();

    // 只读分享页（访客）。
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ReadOnlyTranscript
          source={localSource}
          sessionId={TIMELINE_ID}
          workspaceId="w1"
        />
      </QueryClientProvider>,
    );
    await screen.findByText("lint is clean");
    expect(turns()).toEqual(onCanvas);
    expect(localSource.sourceId).toBe(LOCAL_SOURCE_ID);
    expect(api.log).not.toHaveBeenCalled();
  });
});
