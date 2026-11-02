import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { TerminalNodeData, TimelineItem } from "@armadra/shared";

/**
 * 新建 ACP 会话后的模式 / 模型选择与上下文余量（AMA-Link/Armadra#685）：Agent 还没
 * 报回目录时用候选；起会话前的选择在目录到了以后落上；Agent 报回后以它为准；上下文
 * 余量等首条消息成功发出。
 */
const api = vi.hoisted(() => ({
  createSession: vi.fn(),
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

const store = vi.hoisted(() => ({
  workspace: { id: "w1", rootPath: "/repo" },
  document: null as null | { nodes: Record<string, unknown>[] },
  updateNodeData: vi.fn(),
}));
vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

import { RuntimeRequestError } from "@/api/client";
import { chooseOption, optionLabels } from "@/app/test-harness";
import { resetBlobs } from "@/timeline/blobs";
import { setTimelineTransportFactory } from "@/timeline/api";
import { resetTimelines } from "@/timeline/sync";
import { FakeCore, TIMELINE_ID, user } from "@/timeline/test-support";
import { mockLayout } from "@/timeline/view/test-layout";
import { useAnsweredStore } from "./answered";
import { SessionView } from "./SessionView";
import { useAcpStore } from "./store";

const SESSION = TIMELINE_ID;

const existing: TerminalNodeData = {
  kind: "terminal",
  sessionId: SESSION,
  cwd: "/repo",
  agent: { id: "claude", driver: "acp" },
};

let core: FakeCore;

function push(...ops: Parameters<FakeCore["emit"]>) {
  const delta = core.emit(...ops);
  act(() => core.deliver(delta));
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.prompt.mockResolvedValue({ turnId: "turn-1" });
  api.setMode.mockResolvedValue(undefined);
  api.setModel.mockResolvedValue(undefined);
  api.drive.mockResolvedValue({});
  store.updateNodeData.mockReset();
  store.document = null;
  useAcpStore.getState().reset();
  useAnsweredStore.getState().reset();
  resetBlobs();
  core = new FakeCore();
  setTimelineTransportFactory(() => core.transport);
  mockLayout();
});

afterEach(() => {
  cleanup();
  resetTimelines();
  setTimelineTransportFactory();
  vi.restoreAllMocks();
});

/** 窄屏：模式总是下拉（不是分段控件），好按选项点。 */
function narrow(): () => void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    ...original(query),
    matches: query.includes("767"),
  })) as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

/** 模式下拉里点一项。 */
async function pickMode(name: string) {
  await chooseOption(await screen.findByLabelText("模式"), name);
}

const REPORTED_MODES = {
  currentModeId: "workspace-write",
  availableModes: [
    { id: "workspace-write", name: "Workspace" },
    { id: "agent", name: "Agent" },
    { id: "read-only", name: "Read Only" },
  ],
};

describe("model and mode pickers right after creation", () => {
  it("shows both before the agent reports anything", async () => {
    core.emit({ op: "head", head: {} } as never);
    render(<SessionView nodeId="n1" data={existing} />);
    expect((await screen.findByLabelText("模式")).textContent).toContain(
      "默认",
    );
    expect(screen.getByLabelText("模型").textContent).toContain("默认");
  });

  it("offers the bypass-style mode among the candidates", async () => {
    const restore = narrow();
    try {
      render(<SessionView nodeId="n1" data={existing} />);
      // 窄屏也直接摆在操作行上，没有「⋯」菜单。
      expect(screen.queryByRole("button", { name: "更多" })).toBeNull();
      expect(
        await optionLabels(await screen.findByLabelText("模式")),
      ).toContain("全自动");
    } finally {
      restore();
    }
  });

  it("has no mode picker for an agent without switchable modes, but keeps the model one", async () => {
    render(
      <SessionView
        nodeId="n1"
        data={{ ...existing, agent: { id: "pi", driver: "acp" } }}
      />,
    );
    expect(await screen.findByLabelText("模型")).toBeTruthy();
    expect(screen.queryByLabelText("模式")).toBeNull();
  });

  it("starts on the node's permission mode and model", async () => {
    render(
      <SessionView
        nodeId="n1"
        data={{
          ...existing,
          agent: {
            id: "claude",
            driver: "acp",
            permissionMode: "full-auto",
            model: "sonnet",
          },
        }}
      />,
    );
    expect((await screen.findByLabelText("模式")).textContent).toContain(
      "全自动",
    );
    expect(screen.getByLabelText("模型").textContent).toContain("sonnet");
  });

  it("applies a choice made before the session was up once the agent reports", async () => {
    const restore = narrow();
    try {
      let open: (value: { id: string }) => void = () => undefined;
      api.createSession.mockReturnValue(
        new Promise((resolve) => {
          open = resolve;
        }),
      );
      store.document = {
        nodes: [
          {
            id: "n1",
            data: { kind: "terminal", agent: { id: "codex", driver: "acp" } },
          },
        ],
      };
      const fresh: TerminalNodeData = {
        kind: "terminal",
        agent: { id: "codex", driver: "acp" },
      };
      const view = render(<SessionView nodeId="n1" data={fresh} />);
      await pickMode("计划");
      expect(api.setMode).not.toHaveBeenCalled();

      await act(async () => open({ id: SESSION }));
      view.rerender(
        <SessionView nodeId="n1" data={{ ...fresh, sessionId: SESSION }} />,
      );
      // 会话起来了但目录还没到：仍不发。
      expect(api.setMode).not.toHaveBeenCalled();
      push({ op: "head", head: { modes: REPORTED_MODES } } as never);
      await waitFor(() =>
        expect(api.setMode).toHaveBeenCalledWith(SESSION, "read-only"),
      );
      await waitFor(() =>
        expect(store.updateNodeData).toHaveBeenCalledWith(
          "n1",
          { agent: { id: "codex", driver: "acp", permissionMode: "plan" } },
          { history: "ignore" },
        ),
      );
    } finally {
      restore();
    }
  });

  it("drops a pre-session choice the agent does not offer and shows the agent's", async () => {
    const restore = narrow();
    try {
      render(<SessionView nodeId="n1" data={existing} />);
      // claude 的候选里有「全自动」，Agent 报回的没有。
      await pickMode("全自动");
      push({
        op: "head",
        head: {
          modes: {
            currentModeId: "default",
            availableModes: [
              { id: "default", name: "Ask" },
              { id: "plan", name: "Plan" },
            ],
          },
        },
      } as never);
      await waitFor(() =>
        expect(screen.getByLabelText("模式").textContent).toContain("Ask"),
      );
      expect(api.setMode).not.toHaveBeenCalled();
      expect(await optionLabels(screen.getByLabelText("模式"))).not.toContain(
        "全自动",
      );
    } finally {
      restore();
    }
  });

  it("sets the mode straight away once the agent has reported", async () => {
    core.emit({ op: "head", head: { modes: REPORTED_MODES } } as never);
    const restore = narrow();
    try {
      render(
        <SessionView
          nodeId="n1"
          data={{ ...existing, agent: { id: "codex", driver: "acp" } }}
        />,
      );
      await pickMode("Agent");
      await waitFor(() =>
        expect(api.setMode).toHaveBeenCalledWith(SESSION, "agent"),
      );
    } finally {
      restore();
    }
  });

  it("puts the mode back when the agent refuses it", async () => {
    api.setMode.mockRejectedValue(new Error("acp_mode_unavailable"));
    core.emit({ op: "head", head: { modes: REPORTED_MODES } } as never);
    const restore = narrow();
    try {
      render(
        <SessionView
          nodeId="n1"
          data={{ ...existing, agent: { id: "codex", driver: "acp" } }}
        />,
      );
      await pickMode("Agent");
      await waitFor(() => expect(api.setMode).toHaveBeenCalled());
      expect(store.updateNodeData).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(screen.getByLabelText("模式").textContent).toContain(
          "Workspace",
        ),
      );
    } finally {
      restore();
    }
  });
});

describe("context meter", () => {
  const usage = { used: 5_000, size: 200_000 };
  const meter = () => document.querySelector("[data-slot=acp-usage]");

  it("stays hidden until the first message was sent", async () => {
    core.emit({ op: "head", head: { usage } } as never);
    render(<SessionView nodeId="n1" data={existing} />);
    await screen.findByLabelText("消息");
    expect(meter()).toBeNull();
  });

  it("appears once core echoed the first message", async () => {
    core.emit({ op: "head", head: { usage } } as never);
    render(<SessionView nodeId="n1" data={existing} />);
    const input = await screen.findByLabelText("消息");
    fireEvent.change(input, { target: { value: "go" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.prompt).toHaveBeenCalled());
    // 页面先画上的提问不算：core 还没确认。
    expect(meter()).toBeNull();
    const clientTurnId = api.prompt.mock.calls.at(-1)?.[2] as string;
    push({
      op: "put",
      item: { ...user(1, "go"), clientTurnId } as TimelineItem,
    } as never);
    await waitFor(() => expect(meter()).not.toBeNull());
  });

  it("stays hidden when core refuses the first message", async () => {
    api.prompt.mockRejectedValue(
      new RuntimeRequestError(409, "gone", "acp_exited"),
    );
    core.emit({ op: "head", head: { usage } } as never);
    render(<SessionView nodeId="n1" data={existing} />);
    const input = await screen.findByLabelText("消息");
    fireEvent.change(input, { target: { value: "go" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.prompt).toHaveBeenCalled());
    await screen.findByText("没有发出去").catch(() => undefined);
    expect(meter()).toBeNull();
  });

  it("shows for a session that already has messages", async () => {
    core.emit(
      { op: "put", item: user(1, "earlier") } as never,
      { op: "head", head: { usage } } as never,
    );
    render(<SessionView nodeId="n1" data={existing} />);
    await screen.findByText("earlier");
    expect(meter()).not.toBeNull();
  });
});
