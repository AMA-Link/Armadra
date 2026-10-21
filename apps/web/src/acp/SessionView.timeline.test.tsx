import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  SessionActivity,
  TerminalNodeData,
  TimelineItem,
} from "@armadra/shared";

/**
 * 会话视图的时间线路径：`timeline.open` / `sync` / 推送的 `timeline.delta`，投递对账
 * 看时间线里有没有带同一个 `clientTurnId` 的用户条目。
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
  document: null,
  updateNodeData: vi.fn(),
}));
vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

import { resetBlobs } from "@/timeline/blobs";
import { setTimelineTransportFactory } from "@/timeline/api";
import { resetTimelines } from "@/timeline/sync";
import {
  FakeCore,
  TIMELINE_ID,
  assistant,
  user,
} from "@/timeline/test-support";
import { mockLayout } from "@/timeline/view/test-layout";
import { useAnsweredStore } from "./answered";
import { SessionView } from "./SessionView";
import { useAcpStore } from "./store";

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

function echo(turn: number, text: string, clientTurnId: string): TimelineItem {
  return { ...user(turn, text), clientTurnId };
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.prompt.mockResolvedValue({ turnId: "turn-1" });
  api.answer.mockResolvedValue({});
  api.drive.mockResolvedValue({});
  store.updateNodeData.mockReset();
  useAcpStore.getState().reset();
  useAnsweredStore.getState().reset();
  resetBlobs();
  core = new FakeCore();
  core.emit(
    { op: "put", item: user(1, "first question") } as never,
    { op: "put", item: assistant(1, "first answer") } as never,
  );
  setTimelineTransportFactory(() => core.transport);
  mockLayout();
});

afterEach(() => {
  cleanup();
  resetTimelines();
  setTimelineTransportFactory();
  vi.restoreAllMocks();
});

async function ready() {
  render(<SessionView nodeId="n1" data={data} />);
  return screen.findByText("first answer");
}

async function sendPrompt(value: string) {
  const input = await screen.findByLabelText("消息");
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(api.prompt).toHaveBeenCalled());
  return api.prompt.mock.calls.at(-1)?.[2] as string;
}

describe("SessionView on the timeline", () => {
  it("draws the opened timeline", async () => {
    core.emit({
      op: "head",
      head: {
        modes: {
          currentModeId: "default",
          availableModes: [{ id: "default", name: "Default" }],
        },
      },
    } as never);
    await ready();
    expect(screen.getByText("first question")).toBeTruthy();
    expect(screen.getByRole("log").getAttribute("aria-live")).toBe("off");
    expect(core.calls).toEqual(["open"]);
  });

  it("takes modes, usage and commands from the head values", async () => {
    core.emit({
      op: "head",
      head: {
        modes: {
          currentModeId: "plan",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "plan", name: "Plan" },
          ],
        },
        usage: { used: 950, size: 1000 },
        commands: [{ name: "review", description: "" }],
      },
    } as never);
    await ready();
    expect(screen.getByLabelText("模式").textContent).toContain("Plan");
    expect(
      document.querySelector("[data-slot=acp-usage]")?.textContent,
    ).toContain("950");
  });

  it("draws the question at once and swaps it for core's echo", async () => {
    await ready();
    const clientTurnId = await sendPrompt("go");
    expect(screen.getByText("go")).toBeTruthy();
    // 提问发出、还没回显：输入框是「停止」，活动行说在提交。
    expect(screen.getByLabelText("停止")).toBeTruthy();
    expect(
      await waitFor(() =>
        document.querySelector("[data-slot=timeline-activity]"),
      ),
    ).toBeTruthy();
    // core 把它回显成带同一个 `clientTurnId` 的用户条目：只剩一句。
    push({
      op: "put",
      item: echo(2, "go", clientTurnId),
    } as never);
    await waitFor(() => expect(screen.getAllByText("go")).toHaveLength(1));
    expect(useAcpStore.getState().sessions).not.toEqual({});
  });

  it("edits a question back into the input and regenerates the last turn", async () => {
    await ready();
    // 编辑后重发：回填输入框，不发。
    fireEvent.click(screen.getByLabelText("编辑后重发"));
    const input = (await screen.findByLabelText("消息")) as HTMLTextAreaElement;
    await waitFor(() => expect(input.value).toBe("first question"));
    expect(api.prompt).not.toHaveBeenCalled();
    // 重新生成：新一轮重发同一句提问。
    fireEvent.click(screen.getByLabelText("重新生成"));
    await waitFor(() => expect(api.prompt).toHaveBeenCalledTimes(1));
    expect(api.prompt.mock.calls[0]?.[1]).toBe("first question");
    // 回合在跑时不再给重新生成。
    expect(screen.queryByLabelText("重新生成")).toBeNull();
  });

  it("stops being busy when the activity layer goes idle", async () => {
    core.currentActivity = {
      phase: "responding",
      since: Date.now(),
      rev: "boot:1",
    } as SessionActivity;
    await ready();
    expect(screen.getByLabelText("停止")).toBeTruthy();
    act(() =>
      core.deliverActivity({
        phase: "idle",
        since: Date.now(),
        rev: "boot:2",
      } as SessionActivity),
    );
    await waitFor(() => expect(screen.queryByLabelText("停止")).toBeNull());
    expect(screen.getByLabelText("发送")).toBeTruthy();
  });

  it("pins a single pending approval above the input, answers it and folds it away", async () => {
    core.emit(
      {
        op: "put",
        item: {
          id: "tool:t1",
          kind: "tool",
          turn: 1,
          ord: 5,
          rev: 0,
          source: "acp",
          at: 1,
          gen: 1,
          toolCallId: "t1",
          toolKind: "execute",
          title: "rm -rf dist",
          status: "pending",
          locations: [],
          content: [],
          startedAt: 1,
        },
      } as never,
      {
        op: "put",
        item: {
          id: "ap:p1",
          kind: "approval",
          turn: 1,
          ord: 6,
          rev: 0,
          source: "acp",
          at: 2,
          gen: 1,
          pendingId: "p1",
          protocol: "acp",
          toolCallId: "t1",
          options: [
            { optionId: "ok", name: "Allow", kind: "allow_once" },
            { optionId: "no", name: "Reject", kind: "reject_once" },
          ],
          state: "pending",
        },
      } as never,
    );
    await ready();
    // 钉在输入框上方的那一张，标题从工具条目来；行内不再画第二张。
    const cards = document.querySelectorAll("[data-slot=acp-permission]");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.textContent).toContain("rm -rf dist");
    fireEvent.click(screen.getByRole("button", { name: "本次允许" }));
    expect(api.answer).toHaveBeenCalledWith("p1", "allow", "ok");
    expect(document.querySelector("[data-slot=acp-permission]")).toBeNull();
    // core 回执：审批条目收成一行结局。
    push({
      op: "put",
      item: {
        id: "ap:p1",
        kind: "approval",
        turn: 1,
        ord: 6,
        rev: 0,
        source: "acp",
        at: 2,
        gen: 1,
        pendingId: "p1",
        protocol: "acp",
        toolCallId: "t1",
        options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }],
        state: "answered",
        answer: { optionId: "ok" },
        answeredBy: "alice",
      },
    } as never);
    expect(await screen.findByText("已允许")).toBeTruthy();
    expect(screen.getByText("alice")).toBeTruthy();
  });

  it("shows who it waits for instead of approval buttons to someone who cannot answer", async () => {
    core.emit({
      op: "put",
      item: {
        id: "ap:p1",
        kind: "approval",
        turn: 1,
        ord: 6,
        rev: 0,
        source: "acp",
        at: 2,
        gen: 1,
        pendingId: "p1",
        protocol: "acp",
        options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }],
        state: "pending",
      },
    } as never);
    // 只读查看：没有输入框，也没有答复按钮。
    render(
      <SessionView nodeId="n1" data={data} readOnly sessionId={SESSION} />,
    );
    await screen.findByText("first answer");
    expect(screen.queryByLabelText("消息")).toBeNull();
    expect(screen.queryByRole("button", { name: "本次允许" })).toBeNull();
    expect(api.createSession).not.toHaveBeenCalled();
  });

  it("reads the mode and model catalogs from the head values", async () => {
    core.emit({
      op: "head",
      head: {
        modes: {
          currentModeId: "plan",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "plan", name: "Plan" },
          ],
        },
        models: {
          currentModelId: "small",
          availableModels: [{ modelId: "small", name: "Small" }],
        },
      },
    } as never);
    await ready();
    expect(screen.getByLabelText("模式").textContent).toContain("Plan");
    expect(screen.getByLabelText("模型").textContent).toContain("Small");
  });

  it("offers attachments once the head carries the prompt capabilities", async () => {
    core.emit({
      op: "head",
      head: { promptCapabilities: { image: true, embeddedContext: false } },
    } as never);
    await ready();
    expect(
      await screen.findByRole("button", { name: "添加附件" }),
    ).toBeTruthy();
  });

  it("offers no attachments while the head has no prompt capabilities", async () => {
    await ready();
    expect(screen.queryByRole("button", { name: "添加附件" })).toBeNull();
  });

  it("does not start anything for a read-only body", async () => {
    render(
      <SessionView nodeId="n1" data={data} readOnly sessionId={SESSION} />,
    );
    expect(await screen.findByText("first answer")).toBeTruthy();
    expect(api.createSession).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("消息")).toBeNull();
  });
});
