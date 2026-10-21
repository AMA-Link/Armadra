import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  TerminalNodeData,
  TimelineItem,
  TimelineTurnItem,
} from "@armadra/shared";

import { mockLayout } from "@/timeline/view/test-layout";

/** 假 core：会话视图只经 `acpApi` 说话，换掉这一个模块就够了。 */
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
  workspace: { id: "w1", rootPath: "/repo" } as null | {
    id: string;
    rootPath: string;
  },
  document: null as null | { nodes: Record<string, unknown>[] },
  updateNodeData: vi.fn(),
}));
vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

/** 控制面的连上 / 断开：测试自己报。 */
const connection = vi.hoisted(() => ({
  handlers: new Set<(id: string, connected: boolean, source: string) => void>(),
}));
vi.mock("@/api/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/events")>();
  return {
    ...actual,
    onWorkspaceConnection: (
      handler: (id: string, connected: boolean, source: string) => void,
    ) => {
      connection.handlers.add(handler);
      return () => connection.handlers.delete(handler);
    },
  };
});

import { RuntimeRequestError } from "@/api/client";
import { dispatchWorkspaceEvent } from "@/api/events";
import { resetBlobs } from "@/timeline/blobs";
import { setTimelineTransportFactory } from "@/timeline/api";
import { resetTimelines } from "@/timeline/sync";
import {
  FakeCore,
  TIMELINE_ID,
  assistant,
  frame,
  put,
  user,
} from "@/timeline/test-support";
import { useAnsweredStore } from "./answered";
import { SessionView } from "./SessionView";
import { useAcpStore } from "./store";

/**
 * 会话视图的投递对账、起会话、选择器与各类条目：内容都来自时间线（`FakeCore`
 * 的 `open` / `sync` / 推送帧）。基本的渲染与投递主线在 `SessionView.timeline.test.tsx`。
 */
const SESSION = TIMELINE_ID;

const data: TerminalNodeData = {
  kind: "terminal",
  sessionId: SESSION,
  cwd: "/repo",
  agent: { id: "codex", driver: "acp" },
};

let core: FakeCore;

/** 把 core 上发生的一件事当一帧推给页面。 */
function push(...ops: Parameters<FakeCore["emit"]>) {
  const delta = core.emit(...ops);
  act(() => core.deliver(delta));
}

function emit(event: Record<string, unknown>) {
  act(() => dispatchWorkspaceEvent(event as never));
}

function echo(turn: number, text: string, clientTurnId: string): TimelineItem {
  return { ...user(turn, text), clientTurnId };
}

function turnItem(
  turn: number,
  extra: Partial<TimelineTurnItem> = {},
): TimelineItem {
  return {
    id: `turn:${turn}`,
    kind: "turn",
    turn,
    ord: 9,
    rev: 0,
    source: "acp",
    at: 1_000 + turn,
    gen: 1,
    turnId: `turn-${turn}`,
    startedAt: 1_000 + turn,
    permissionWaitMs: 0,
    ...extra,
  };
}

function toolItem(
  turn: number,
  toolCallId: string,
  title: string,
  status: "pending" | "in_progress" | "completed",
): TimelineItem {
  return {
    id: `tool:${toolCallId}`,
    kind: "tool",
    turn,
    ord: 5,
    rev: 0,
    source: "acp",
    at: 1,
    gen: 1,
    toolCallId,
    toolKind: "execute",
    title,
    status,
    locations: [],
    content: [],
    startedAt: 1,
  };
}

function approvalItem(
  turn: number,
  pendingId: string,
  toolCallId: string,
  state: "pending" | "answered" = "pending",
  kind: "allow_once" | "allow_always" = "allow_once",
): TimelineItem {
  return {
    id: `ap:${pendingId}`,
    kind: "approval",
    turn,
    ord: 6,
    rev: 0,
    source: "acp",
    at: 2,
    gen: 1,
    pendingId,
    protocol: "acp",
    toolCallId,
    options: [
      { optionId: "ok", name: "Allow", kind },
      { optionId: "no", name: "Reject", kind: "reject_once" },
    ],
    state,
  };
}

function elicitationItem(
  turn: number,
  pendingId: string,
  message: string,
  state: "pending" | "cancelled" = "pending",
  requestedSchema?: unknown,
): TimelineItem {
  return {
    id: `el:${pendingId}`,
    kind: "elicitation",
    turn,
    ord: 6,
    rev: 0,
    source: "acp",
    at: 2,
    gen: 1,
    pendingId,
    message,
    mode: "form",
    ...(requestedSchema === undefined
      ? {}
      : { requestedSchema: JSON.stringify(requestedSchema) }),
    state,
  };
}

/** 让下一次 `open` / `sync` 停住，直到测试放行。 */
function gate(method: "open" | "sync") {
  const fn = vi.mocked(core.transport[method]) as unknown as ReturnType<
    typeof vi.fn
  >;
  const real = fn.getMockImplementation() as (...args: unknown[]) => unknown;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  fn.mockImplementationOnce(async (...args: unknown[]) => {
    await held;
    return real(...args);
  });
  return release;
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.prompt.mockResolvedValue({ turnId: "turn-1" });
  api.drive.mockResolvedValue({});
  api.answer.mockResolvedValue({});
  api.cancel.mockResolvedValue(undefined);
  api.setModel.mockResolvedValue(undefined);
  api.answerElicitation.mockResolvedValue({});
  store.updateNodeData.mockReset();
  store.document = null;
  store.workspace = { id: "w1", rootPath: "/repo" };
  useAcpStore.getState().reset();
  useAnsweredStore.getState().reset();
  resetBlobs();
  core = new FakeCore();
  setTimelineTransportFactory(() => core.transport);
  mockLayout();
});

const MODELS = {
  currentModelId: "small",
  availableModels: [
    { modelId: "small", name: "Small" },
    { modelId: "large", name: "Large" },
  ],
};

const MODES = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Default" },
    { id: "plan", name: "Plan" },
  ],
};

/**
 * 选一个模型。jsdom 里 Radix 的 Select 打不开（缺 pointer capture），走窄屏
 * 的「⋯」菜单——同一个回调。
 */
async function pickModel(name: string) {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    ...original(query),
    matches: query.includes("767"),
  })) as typeof window.matchMedia;
  try {
    render(<SessionView nodeId="n1" data={data} />);
    const more = await screen.findByRole("button", { name: "更多" });
    fireEvent.pointerDown(more, { button: 0, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name }));
  } finally {
    window.matchMedia = original;
  }
}

/** 当前选中的模型名：宽屏读选择器，窄屏打开「⋯」菜单读选中的那一项。 */
async function checkedModel(): Promise<string | null> {
  const select = screen.queryByLabelText("模型");
  if (select) return select.textContent;
  const more = await screen.findByRole("button", { name: "更多" });
  fireEvent.pointerDown(more, { button: 0, pointerType: "mouse" });
  const items = await screen.findAllByRole("menuitemradio");
  const checked = items.find(
    (item) =>
      item.getAttribute("aria-checked") === "true" &&
      /Small|Large/.test(item.textContent ?? ""),
  );
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Escape",
  });
  return checked?.textContent ?? null;
}

afterEach(() => {
  cleanup();
  resetTimelines();
  setTimelineTransportFactory();
  vi.restoreAllMocks();
});

/**
 * 消息流本身（`role="log"`）。回合结束时最后一条助手文字还会出现在读屏的
 * `role="status"` 里（§5.7），按文字找消息要限定在这里面。
 */
const messages = () => within(screen.getByRole("log"));

function setConnected(connected: boolean) {
  act(() => {
    for (const handler of [...connection.handlers])
      handler("w1", connected, "local");
  });
}

async function sendPrompt(value: string) {
  const input = await screen.findByLabelText("消息");
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(api.prompt).toHaveBeenCalled());
  return api.prompt.mock.calls.at(-1)?.[2] as string;
}

const emptyHint = "向它说第一句话";

describe("SessionView turn reconciliation (§39.9)", () => {
  it("confirms a turn whose request was lost on the way and draws its real outcome", async () => {
    render(<SessionView nodeId="n1" data={data} />);
    await screen.findByText(emptyHint);
    // 请求在路上断了，但 core 其实收到并跑完了：同步卡住时画「正在确认」。
    const release = gate("sync");
    api.prompt.mockImplementationOnce(
      async (_session: string, _text: string, clientTurnId: string) => {
        core.emit(
          { op: "put", item: echo(1, "go", clientTurnId) } as never,
          { op: "put", item: assistant(1, "done it") } as never,
          {
            op: "put",
            item: turnItem(1, { endedAt: 2_000, stopReason: "end_turn" }),
          } as never,
        );
        throw new TypeError("Failed to fetch");
      },
    );
    const clientTurnId = await sendPrompt("go");
    expect(clientTurnId).toMatch(/.+/);
    expect(await screen.findByText("正在确认这一轮")).toBeTruthy();
    expect(screen.queryByText("这一轮没有完成")).toBeNull();
    release();
    expect(await messages().findByText("done it")).toBeTruthy();
    expect(screen.queryByText("正在确认这一轮")).toBeNull();
    expect(screen.queryByText("这一轮没有送达")).toBeNull();
    expect(screen.queryByLabelText("停止")).toBeNull();
    expect(api.prompt).toHaveBeenCalledTimes(1);
  });

  it("keeps streaming when the lost turn is still running", async () => {
    render(<SessionView nodeId="n1" data={data} />);
    await screen.findByText(emptyHint);
    api.prompt.mockImplementationOnce(
      async (_session: string, _text: string, clientTurnId: string) => {
        core.emit(
          { op: "put", item: echo(1, "go", clientTurnId) } as never,
          { op: "put", item: assistant(1, "done it", true) } as never,
          { op: "put", item: turnItem(1) } as never,
        );
        throw new TypeError("Failed to fetch");
      },
    );
    await sendPrompt("go");
    expect(await messages().findByText("done it")).toBeTruthy();
    expect(screen.getByLabelText("停止")).toBeTruthy();
    // 结束帧到了：照常收尾。
    push({
      op: "put",
      item: turnItem(1, { endedAt: 2_000, stopReason: "end_turn" }),
    } as never);
    await waitFor(() => expect(screen.queryByLabelText("停止")).toBeNull());
  });

  it("says not delivered when core has no such turn, ignores another turn's echo, and retries with the same id", async () => {
    render(<SessionView nodeId="n1" data={data} />);
    await screen.findByText(emptyHint);
    api.prompt.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const clientTurnId = await sendPrompt("go");
    expect(await screen.findByText("这一轮没有送达")).toBeTruthy();
    // 提问留在时间线上，等重试。
    expect(screen.getByText("go")).toBeTruthy();
    // 另一个人的一轮不是它的结局。
    push(
      { op: "put", item: echo(1, "other question", "someone-else") } as never,
      {
        op: "put",
        item: turnItem(1, { endedAt: 2_000, stopReason: "end_turn" }),
      } as never,
    );
    expect(screen.getByText("这一轮没有送达")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(api.prompt).toHaveBeenCalledTimes(2));
    expect(api.prompt).toHaveBeenLastCalledWith(SESSION, "go", clientTurnId);
    expect(screen.queryByText("这一轮没有送达")).toBeNull();
    expect(screen.getAllByText("go")).toHaveLength(1);
  });

  it("gives up confirming when the timeline stays unreachable, still retrying with the same id", async () => {
    render(<SessionView nodeId="n1" data={data} />);
    await screen.findByText(emptyHint);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      api.prompt.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      vi.mocked(core.transport.sync).mockRejectedValue(
        new TypeError("Failed to fetch"),
      );
      const clientTurnId = await sendPrompt("go");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(screen.getByText("这一轮没有送达")).toBeTruthy();
      expect(vi.mocked(core.transport.sync).mock.calls.length).toBeGreaterThan(
        2,
      );
      api.prompt.mockResolvedValueOnce({ turnId: "1-1" });
      fireEvent.click(screen.getByRole("button", { name: "重试" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(api.prompt).toHaveBeenLastCalledWith(SESSION, "go", clientTurnId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails at once when core refuses the prompt with a code", async () => {
    render(<SessionView nodeId="n1" data={data} />);
    await screen.findByText(emptyHint);
    api.prompt.mockRejectedValueOnce(
      new RuntimeRequestError(409, "gone", "acp_exited"),
    );
    await sendPrompt("go");
    expect(await screen.findByText("这一轮没有完成")).toBeTruthy();
    expect(screen.queryByText("正在确认这一轮")).toBeNull();
    expect(core.calls.filter((call) => call.startsWith("sync:"))).toEqual([]);
  });

  it("resyncs after the stream reconnects and ends a turn it missed", async () => {
    render(<SessionView nodeId="n1" data={data} />);
    await screen.findByText(emptyHint);
    const clientTurnId = await sendPrompt("go");
    expect(screen.getByLabelText("停止")).toBeTruthy();
    setConnected(false);
    // 断线期间 core 跑完了这一轮，帧没送到。
    core.emit(
      { op: "put", item: echo(1, "go", clientTurnId) } as never,
      { op: "put", item: assistant(1, "done it") } as never,
      {
        op: "put",
        item: turnItem(1, { endedAt: 2_000, stopReason: "end_turn" }),
      } as never,
    );
    setConnected(true);
    act(() => core.reconnect());
    expect(await messages().findByText("done it")).toBeTruthy();
    await waitFor(() => expect(screen.queryByLabelText("停止")).toBeNull());
  });

  it("does not resync on the first connected report", async () => {
    render(<SessionView nodeId="n1" data={data} />);
    await screen.findByText(emptyHint);
    setConnected(true);
    expect(core.calls).toEqual(["open"]);
  });
});

describe("SessionView", () => {
  it("同一个节点挂两份会话视图（手机焦点页 + 画布）时分块只拼一遍", async () => {
    render(
      <>
        <SessionView nodeId="n1" data={data} />
        <SessionView nodeId="n1" data={data} />
      </>,
    );
    await waitFor(() => expect(screen.getAllByText(emptyHint)).toHaveLength(2));
    push({ op: "put", item: assistant(1, "echo: ", true) } as never);
    push({ op: "append", itemId: "a:1:0", delta: { text: "hi" } } as never);
    await waitFor(() =>
      expect(screen.getAllByText("echo: hi")).toHaveLength(2),
    );
    expect(screen.queryByText("echo: hiecho: hi")).toBeNull();
  });

  it("shows skeletons while loading, then the empty state", async () => {
    const release = gate("open");
    const { container } = render(<SessionView nodeId="n1" data={data} />);
    expect(container.querySelector('[data-slot="acp-loading"]')).not.toBeNull();
    release();
    expect(await screen.findByText(emptyHint)).toBeTruthy();
    expect(container.querySelector('[data-slot="acp-loading"]')).toBeNull();
  });

  it("turns the timeline frames into messages, tool rows and a permission card", async () => {
    render(<SessionView nodeId="n1" data={data} />);
    await screen.findByText(emptyHint);

    const clientTurnId = await sendPrompt("跑一下测试");
    expect(api.prompt).toHaveBeenCalledWith(
      SESSION,
      "跑一下测试",
      expect.any(String),
    );
    expect(screen.getByText("跑一下测试")).toBeTruthy();
    // 回合进行中：发送钮换成停止。
    expect(screen.getByLabelText("停止")).toBeTruthy();

    push(
      { op: "put", item: echo(1, "跑一下测试", clientTurnId) } as never,
      { op: "put", item: turnItem(1) } as never,
      { op: "put", item: assistant(1, "Running ", true) } as never,
    );
    push({ op: "append", itemId: "a:1:0", delta: { text: "tests" } } as never);
    expect(await screen.findByText("Running tests")).toBeTruthy();

    push({
      op: "put",
      item: toolItem(1, "t1", "pnpm test", "in_progress"),
    } as never);
    expect(await screen.findByText("pnpm test")).toBeTruthy();
    expect(await screen.findByText("运行中")).toBeTruthy();
    push({
      op: "put",
      item: toolItem(1, "t1", "pnpm test", "completed"),
    } as never);
    expect(await screen.findByText("已完成")).toBeTruthy();

    push(
      { op: "put", item: toolItem(1, "t2", "rm -rf dist", "pending") } as never,
      { op: "put", item: approvalItem(1, "n1-1-acp-t2", "t2") } as never,
    );
    expect((await screen.findAllByText("rm -rf dist")).length).toBeGreaterThan(
      0,
    );
    fireEvent.click(await screen.findByRole("button", { name: "本次允许" }));
    expect(api.answer).toHaveBeenCalledWith("n1-1-acp-t2", "allow", "ok");
    // 答过的卡先收起，不等回执。
    expect(screen.queryByRole("button", { name: "本次允许" })).toBeNull();

    push({
      op: "put",
      item: turnItem(1, { endedAt: 3_000, stopReason: "end_turn" }),
    } as never);
    await waitFor(() => expect(screen.queryByLabelText("停止")).toBeNull());
    expect(screen.getByLabelText("发送")).toBeTruthy();

    // 回合边界之后的输出是新的一条，不接在上一条后面。
    push({ op: "put", item: assistant(2, "Next") } as never);
    expect(await messages().findByText("Next")).toBeTruthy();
    expect(messages().getByText("Running tests")).toBeTruthy();
    // 回合结束时读屏念一次最后那条回复（消息流本身不逐块念）。
    expect(screen.getByRole("log").getAttribute("aria-live")).toBe("off");
    expect(screen.getByRole("status").textContent).toBe("Running tests");
  });

  it("ignores frames of other timelines", async () => {
    render(<SessionView nodeId="n1" data={data} />);
    await screen.findByText(emptyHint);
    act(() =>
      core.deliver(
        frame(0, 1, [put(1, assistant(1, "elsewhere"))], "other-session"),
      ),
    );
    expect(screen.queryByText("elsewhere")).toBeNull();
  });

  it("rebuilds from the opened timeline and draws a pending permission after a reload", async () => {
    core.emit(
      { op: "put", item: user(1, "hello") } as never,
      { op: "put", item: assistant(1, "hi there") } as never,
      { op: "put", item: toolItem(1, "t9", "write a.ts", "pending") } as never,
      {
        op: "put",
        item: approvalItem(1, "p1", "t9", "pending", "allow_always"),
      } as never,
      { op: "head", head: { modes: MODES } } as never,
    );
    render(<SessionView nodeId="n1" data={data} />);
    expect(await screen.findByText("hello")).toBeTruthy();
    expect(screen.getByText("hi there")).toBeTruthy();
    expect(screen.getAllByText("write a.ts").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "始终允许" })).toBeTruthy();
    expect(screen.getByLabelText("模式")).toBeTruthy();
  });

  it("offers a retry when the timeline cannot be opened", async () => {
    core.failNext = new Error("down");
    render(<SessionView nodeId="n1" data={data} />);
    fireEvent.click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByText(emptyHint)).toBeTruthy();
  });

  it("shows a failed turn with a retry that resends the prompt", async () => {
    render(<SessionView nodeId="n1" data={data} />);
    await screen.findByText(emptyHint);
    const first = await sendPrompt("go");
    push(
      { op: "put", item: echo(1, "go", first) } as never,
      {
        op: "put",
        item: turnItem(1, {
          endedAt: 2_000,
          error: { code: "acp_protocol", message: "boom" },
        }),
      } as never,
    );
    // 回合尾：core 说的原话加重试。
    expect(await screen.findByText("boom")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(api.prompt).toHaveBeenCalledTimes(2));
    // 第三个参数是 §39.9 的 clientTurnId：出错的是 core 跑完的一轮，重发是新的
    // 一轮，换一个 id（沿用旧的会被 core 当成同一轮去重掉）。
    expect(api.prompt).toHaveBeenLastCalledWith(
      SESSION,
      "go",
      expect.any(String),
    );
    expect(api.prompt.mock.calls[1]?.[2]).not.toBe(first);
  });

  it.each([
    ["max_tokens", "已达上限", "继续"],
    ["max_turn_requests", "已达上限", "继续"],
    ["refusal", "已拒绝", null],
    ["cancelled", "已取消", null],
  ] as const)(
    "draws a row for the %s stop reason (§5.2)",
    async (stopReason, line, action) => {
      render(<SessionView nodeId="n1" data={data} />);
      const id = await sendPrompt(`ask ${stopReason}`);
      push(
        { op: "put", item: echo(1, `ask ${stopReason}`, id) } as never,
        {
          op: "put",
          item: turnItem(1, { endedAt: 2_000, stopReason }),
        } as never,
      );
      const row = (await screen.findByText(line)).closest(
        "[data-stop]",
      ) as HTMLElement;
      expect(row.dataset.stop).toBe(stopReason);
      expect(screen.queryByText("这一轮没有完成")).toBeNull();
      if (action === null) {
        expect(within(row).queryByRole("button")).toBeNull();
      } else {
        expect(within(row).getByRole("button", { name: action })).toBeTruthy();
      }
    },
  );

  it("draws nothing extra for a turn that ended normally", async () => {
    render(<SessionView nodeId="n1" data={data} />);
    const id = await sendPrompt("fine");
    push(
      { op: "put", item: echo(1, "fine", id) } as never,
      {
        op: "put",
        item: turnItem(1, { endedAt: 2_000, stopReason: "end_turn" }),
      } as never,
    );
    await waitFor(() => expect(screen.queryByLabelText("停止")).toBeNull());
    for (const line of ["已达上限", "已拒绝", "已取消"])
      expect(screen.queryByText(line)).toBeNull();
  });

  it("continues from the limit row with a new turn id", async () => {
    render(<SessionView nodeId="n1" data={data} />);
    const first = await sendPrompt("long one");
    push(
      { op: "put", item: echo(1, "long one", first) } as never,
      {
        op: "put",
        item: turnItem(1, { endedAt: 2_000, stopReason: "max_tokens" }),
      } as never,
    );
    fireEvent.click(await screen.findByRole("button", { name: "继续" }));
    await waitFor(() =>
      expect(api.prompt).toHaveBeenLastCalledWith(
        SESSION,
        "继续",
        expect.any(String),
      ),
    );
    expect(api.prompt.mock.calls[1]?.[2]).not.toBe(first);
  });

  it("lets text be selected and keeps the canvas from panning or dragging", async () => {
    const { container } = render(<SessionView nodeId="n1" data={data} />);
    await screen.findByText(emptyHint);
    const root = container.querySelector("[data-slot=acp-session-view]")!;
    for (const name of ["select-text", "nopan", "nodrag", "nowheel"])
      expect(root.classList.contains(name)).toBe(true);
  });

  it("lists the agent's slash commands while typing / and inserts one", async () => {
    // cmdk 把选中的项滚进视野；jsdom 没有这个方法。
    Element.prototype.scrollIntoView ??= () => undefined;
    render(<SessionView nodeId="n1" data={data} />);
    const input = (await screen.findByLabelText("消息")) as HTMLTextAreaElement;
    await screen.findByText(emptyHint);
    push({
      op: "head",
      head: {
        commands: [
          { name: "review", description: "Review changes" },
          { name: "init", description: "Write AGENTS.md" },
        ],
      },
    } as never);
    fireEvent.change(input, { target: { value: "/" } });
    expect(await screen.findByText("/review")).toBeTruthy();
    expect(screen.getByText("/init")).toBeTruthy();
    fireEvent.change(input, { target: { value: "/in" } });
    expect(screen.queryByText("/review")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("/init ");
    expect(api.prompt).not.toHaveBeenCalled();
    // 有空格之后不再弹；Esc 收起。
    expect(document.querySelector("[data-slot=acp-commands]")).toBeNull();
    fireEvent.change(input, { target: { value: "/re" } });
    expect(document.querySelector("[data-slot=acp-commands]")).not.toBeNull();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(document.querySelector("[data-slot=acp-commands]")).toBeNull();
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it("restores the plan, usage and commands from the opened timeline (§49)", async () => {
    core.emit(
      { op: "put", item: user(1, "plan it") } as never,
      {
        op: "put",
        item: {
          id: "plan:1",
          kind: "plan",
          turn: 1,
          ord: 2,
          rev: 0,
          source: "acp",
          at: 2,
          gen: 1,
          entries: [
            { content: "step one", status: "completed" },
            { content: "step two", status: "pending" },
          ],
        },
      } as never,
      {
        op: "head",
        head: {
          usage: { used: 950, size: 1000 },
          commands: [{ name: "review", description: "" }],
          title: "Planning",
        },
      } as never,
    );
    render(<SessionView nodeId="n1" data={data} />);
    const bar = await screen.findByLabelText("计划");
    expect(bar.textContent).toContain("step two");
    expect(bar.textContent).toContain("1 / 2");
    const usage = document.querySelector("[data-slot=acp-usage]");
    expect(usage?.textContent).toContain("950");
    expect(usage?.getAttribute("data-warn")).toBe("true");
  });

  it("starts a session when the node has none and records its id", async () => {
    api.createSession.mockResolvedValue({ id: SESSION });
    const fresh: TerminalNodeData = {
      kind: "terminal",
      cwd: "/repo/app",
      agent: { id: "codex", driver: "acp", permissionMode: "plan" },
    };
    render(<SessionView nodeId="n1" data={fresh} />);
    await waitFor(() =>
      expect(store.updateNodeData).toHaveBeenCalledWith(
        "n1",
        { sessionId: SESSION, lastExitCode: null },
        { history: "ignore" },
      ),
    );
    expect(api.createSession).toHaveBeenCalledWith({
      workspaceId: "w1",
      nodeId: "n1",
      cwd: "/repo/app",
      agentId: "codex",
      permissionMode: "plan",
    });
  });

  it("leaves the loading state once the new session id is written back", async () => {
    // 写回会话 id 会让起会话的 effect 自己被清理（依赖变了）；清理之后「正在起」
    // 也得收起，否则骨架屏永远不走（真浏览器里撞出来的）。
    api.createSession.mockResolvedValue({ id: SESSION });
    const fresh: TerminalNodeData = {
      kind: "terminal",
      agent: { id: "codex", driver: "acp" },
    };
    // 真画布里写回节点数据会同步重渲染这个节点：在写回的那一刻就换上新 id。
    let view: ReturnType<typeof render>;
    store.updateNodeData.mockImplementationOnce(() => {
      view?.rerender(
        <SessionView nodeId="n1" data={{ ...fresh, sessionId: SESSION }} />,
      );
    });
    view = render(<SessionView nodeId="n1" data={fresh} />);
    expect(await screen.findByText("向它说第一句话")).toBeTruthy();
    expect(document.querySelector('[data-slot="acp-loading"]')).toBeNull();
  });

  it("says the session did not start and retries", async () => {
    api.createSession.mockRejectedValueOnce(new Error("acp_not_installed"));
    api.createSession.mockResolvedValueOnce({ id: SESSION });
    const fresh: TerminalNodeData = {
      kind: "terminal",
      agent: { id: "codex", driver: "acp" },
    };
    render(<SessionView nodeId="n1" data={fresh} />);
    expect(await screen.findByText("会话没有启动")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(api.createSession).toHaveBeenCalledTimes(2));
  });

  it("lets the first message be typed while starting and sends it once the session is open (§51)", async () => {
    let open: (value: { id: string }) => void = () => undefined;
    api.createSession.mockReturnValue(
      new Promise((resolve) => {
        open = resolve;
      }),
    );
    const fresh: TerminalNodeData = {
      kind: "terminal",
      agent: { id: "claude", driver: "acp" },
    };
    let view: ReturnType<typeof render>;
    store.updateNodeData.mockImplementationOnce(() => {
      view?.rerender(
        <SessionView nodeId="n1" data={{ ...fresh, sessionId: SESSION }} />,
      );
    });
    view = render(<SessionView nodeId="n1" data={fresh} />);
    const input = await screen.findByLabelText("消息");
    expect((input as HTMLTextAreaElement).disabled).toBe(false);
    input.focus();
    expect(document.activeElement).toBe(input);

    // 阶段提示随 `acp.starting` 变。
    emit({ type: "acp.starting", nodeId: "n1", phase: "spawn", at: "" });
    expect(await screen.findByText("启动适配器")).toBeTruthy();
    emit({ type: "acp.starting", nodeId: "other", phase: "session", at: "" });
    emit({ type: "acp.starting", nodeId: "n1", phase: "initialize", at: "" });
    expect(await screen.findByText("连接")).toBeTruthy();

    fireEvent.change(input, { target: { value: "hi there" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // 先画出用户气泡，请求等会话开好再发。
    expect(await screen.findByText("hi there")).toBeTruthy();
    expect(api.prompt).not.toHaveBeenCalled();

    await act(async () => open({ id: SESSION }));
    await waitFor(() =>
      expect(api.prompt).toHaveBeenCalledWith(
        SESSION,
        "hi there",
        expect.any(String),
      ),
    );
    expect(api.createSession.mock.calls[0]?.[0]).not.toHaveProperty("prompt");
    expect(messages().getByText("hi there")).toBeTruthy();
  });

  it("carries the first message in createSession when the request had not gone out yet (§51)", async () => {
    api.createSession.mockResolvedValue({ id: SESSION });
    store.workspace = null;
    const fresh: TerminalNodeData = {
      kind: "terminal",
      agent: { id: "claude", driver: "acp" },
    };
    let view: ReturnType<typeof render>;
    store.updateNodeData.mockImplementationOnce(() => {
      view?.rerender(
        <SessionView nodeId="n1" data={{ ...fresh, sessionId: SESSION }} />,
      );
    });
    view = render(<SessionView nodeId="n1" data={fresh} />);
    const input = await screen.findByLabelText("消息");
    fireEvent.change(input, { target: { value: "early" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(api.createSession).not.toHaveBeenCalled();

    // 工作空间读到了：起会话，第一条随 `prompt` 一起发。
    store.workspace = { id: "w1", rootPath: "/repo" };
    view.rerender(<SessionView nodeId="n1" data={fresh} />);
    await waitFor(() =>
      expect(api.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "early" }),
      ),
    );
    await waitFor(() => expect(messages().getByText("early")).toBeTruthy());
    expect(api.prompt).not.toHaveBeenCalled();
  });

  it("adds that the first start is slower when loading the config takes long", async () => {
    api.createSession.mockReturnValue(new Promise(() => undefined));
    const fresh: TerminalNodeData = {
      kind: "terminal",
      agent: { id: "claude", driver: "acp" },
    };
    render(<SessionView nodeId="n1" data={fresh} />);
    await screen.findByLabelText("消息");
    vi.useFakeTimers();
    try {
      emit({ type: "acp.starting", nodeId: "n1", phase: "session", at: "" });
      expect(screen.getByText("加载配置")).toBeTruthy();
      expect(screen.queryByText("首次启动较慢")).toBeNull();
      act(() => vi.advanceTimersByTime(3_000));
      expect(screen.getByText("首次启动较慢")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says the start timed out when session/new did not answer (§51)", async () => {
    api.createSession.mockRejectedValueOnce(
      new RuntimeRequestError(504, "timeout", "acp_session_timeout"),
    );
    const fresh: TerminalNodeData = {
      kind: "terminal",
      agent: { id: "claude", driver: "acp" },
    };
    render(<SessionView nodeId="n1" data={fresh} />);
    expect(await screen.findByText("启动超时")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  });

  it("draws an elicitation from the timeline, answers it and folds it away", async () => {
    render(<SessionView nodeId="n1" data={data} />);
    await screen.findByText(emptyHint);
    push({
      op: "put",
      item: elicitationItem(1, "n1-1-acp-e1", "Pick a color", "pending", {
        type: "object",
        properties: {
          color: { type: "string", enum: ["red", "blue"], default: "red" },
        },
        required: ["color"],
      }),
    } as never);
    expect(await screen.findByText("Pick a color")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    await waitFor(() =>
      expect(api.answerElicitation).toHaveBeenCalledWith("n1-1-acp-e1", {
        action: "accept",
        content: { color: "red" },
      }),
    );
    expect(screen.queryByText("Pick a color")).toBeNull();
  });

  it("restores pending elicitations and the model catalog from the timeline", async () => {
    core.emit(
      { op: "put", item: elicitationItem(1, "e1", "Which branch?") } as never,
      { op: "head", head: { models: MODELS } } as never,
    );
    render(<SessionView nodeId="n1" data={data} />);
    expect(await screen.findByText("Which branch?")).toBeTruthy();
    expect((await screen.findByLabelText("模型")).textContent).toContain(
      "Small",
    );
    // 一个 turn 结束时挂起的 elicitation 已由 core 回了 cancel。
    push({
      op: "put",
      item: elicitationItem(1, "e1", "Which branch?", "cancelled"),
    } as never);
    await waitFor(() => expect(screen.queryByText("Which branch?")).toBeNull());
  });

  it("changes the model and writes agent.model back to the node", async () => {
    store.document = {
      nodes: [{ id: "n1", data: { ...data, agent: { ...data.agent } } }],
    };
    core.emit({ op: "head", head: { models: MODELS } } as never);
    await pickModel("Large");
    await waitFor(() =>
      expect(api.setModel).toHaveBeenCalledWith(SESSION, "large"),
    );
    await waitFor(() =>
      expect(store.updateNodeData).toHaveBeenCalledWith(
        "n1",
        { agent: { id: "codex", driver: "acp", model: "large" } },
        { history: "ignore" },
      ),
    );
    expect(await checkedModel()).toBe("Large");
  });

  it("puts the previous model back when the change is refused", async () => {
    api.setModel.mockRejectedValue(new Error("acp_model_unavailable"));
    core.emit({ op: "head", head: { models: MODELS } } as never);
    await pickModel("Large");
    await waitFor(() => expect(api.setModel).toHaveBeenCalled());
    await waitFor(async () => expect(await checkedModel()).toBe("Small"));
    expect(store.updateNodeData).not.toHaveBeenCalled();
  });
});
