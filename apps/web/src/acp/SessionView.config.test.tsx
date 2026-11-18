import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { TerminalNodeData } from "@armadra/shared";

/**
 * 配置项（推理强度、其他 select、boolean）与模式配置项（AMA-Link/Armadra#687，P2-4）：
 * 头部报回的配置项出现在「更多」菜单里，选择先显示、失败回滚并提示，头部更新后以头部为准；
 * 模式以 `category: "mode"` 给出时，模式选择器由 core 写的 `modes` 驱动，不在配置菜单里重复。
 */
const api = vi.hoisted(() => ({
  createSession: vi.fn(),
  prompt: vi.fn(),
  cancel: vi.fn(),
  setMode: vi.fn(),
  setModel: vi.fn(),
  setConfigOption: vi.fn(),
  answerElicitation: vi.fn(),
  switchDriver: vi.fn(),
  answer: vi.fn(),
  drive: vi.fn(),
}));
vi.mock("./api", () => ({ acpApi: api }));

const toasts = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("@/ui/toast", () => ({ toast: toasts }));

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

import { resetBlobs } from "@/timeline/blobs";
import { setTimelineTransportFactory } from "@/timeline/api";
import { resetTimelines } from "@/timeline/sync";
import { FakeCore, TIMELINE_ID } from "@/timeline/test-support";
import {
  modeLabel,
  modelTrigger,
  openModelPopover,
  optionSwitch,
  pickLevel,
} from "./test-support";
import { mockLayout } from "@/timeline/view/test-layout";
import { useAnsweredStore } from "./answered";
import { SessionView } from "./SessionView";
import { useAcpStore } from "./store";

const existing: TerminalNodeData = {
  kind: "terminal",
  sessionId: TIMELINE_ID,
  cwd: "/repo",
  agent: { id: "claude", driver: "acp" },
};

const EFFORT = {
  id: "effort",
  name: "Effort",
  category: "thought_level",
  type: "select",
  currentValue: "low",
  options: [
    { value: "low", name: "Low" },
    { value: "high", name: "High" },
  ],
};
const THINK = {
  id: "think",
  name: "Think",
  type: "boolean",
  currentValue: false,
  options: [],
};
const MODE = {
  id: "mode",
  name: "Mode",
  category: "mode",
  type: "select",
  currentValue: "plan",
  options: [
    { value: "plan", name: "Plan" },
    { value: "code", name: "Code" },
  ],
};

let core: FakeCore;

function push(...ops: Parameters<FakeCore["emit"]>) {
  const delta = core.emit(...ops);
  act(() => core.deliver(delta));
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  toasts.error.mockReset();
  api.setConfigOption.mockResolvedValue(undefined);
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

/** 模型弹层右栏里的配置项控件（不含思考强度）。 */
const inlineConfig = () =>
  document.querySelectorAll(
    "[data-slot=acp-config-select], [data-slot=acp-config-toggle]",
  );

describe("config options in the prompt box", () => {
  it("shows nothing extra while the head has no config options", async () => {
    core.emit({ op: "head", head: {} } as never);
    render(<SessionView nodeId="n1" data={existing} />);
    await screen.findByLabelText("消息");
    expect(inlineConfig()).toHaveLength(0);
    expect(document.querySelector("[data-slot=acp-effort-value]")).toBeNull();
  });

  it("puts the thinking level in the model popover, shows it at once and follows the head", async () => {
    core.emit({
      op: "head",
      head: { configOptions: [EFFORT, THINK] },
    } as never);
    render(<SessionView nodeId="n1" data={existing} />);
    const trigger = await screen.findByLabelText("模型");
    await waitFor(() => expect(trigger.textContent).toContain("Low"));
    await pickLevel("High");
    await waitFor(() =>
      expect(api.setConfigOption).toHaveBeenCalledWith(
        TIMELINE_ID,
        "effort",
        "high",
      ),
    );
    expect(screen.getByLabelText("模型").textContent).toContain("High");
    push({
      op: "head",
      head: { configOptions: [{ ...EFFORT, currentValue: "high" }, THINK] },
    } as never);
    await openModelPopover();
    await waitFor(() =>
      expect(
        screen
          .getByRole("radio", { name: "High" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
  });

  it("sets a boolean option with a switch in the model popover", async () => {
    core.emit({
      op: "head",
      head: { configOptions: [EFFORT, THINK] },
    } as never);
    render(<SessionView nodeId="n1" data={existing} />);
    await screen.findByLabelText("消息");
    await waitFor(() => expect(modelTrigger().textContent).toContain("Low"));
    const toggle = await optionSwitch("Think");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(api.setConfigOption).toHaveBeenCalledWith(
        TIMELINE_ID,
        "think",
        true,
      ),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Think" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
  });

  it("rolls the choice back and says so when the agent refuses it", async () => {
    api.setConfigOption.mockRejectedValue(new Error("acp_config_unavailable"));
    core.emit({ op: "head", head: { configOptions: [EFFORT] } } as never);
    render(<SessionView nodeId="n1" data={existing} />);
    await waitFor(() => expect(modelTrigger().textContent).toContain("Low"));
    await pickLevel("High");
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith("设置没有生效"),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("模型").textContent).toContain("Low"),
    );
  });

  it("leaves model and mode options to their own pickers", async () => {
    core.emit({
      op: "head",
      head: {
        configOptions: [
          MODE,
          { ...EFFORT, id: "model", category: "model", name: "Model" },
        ],
        modes: {
          currentModeId: "plan",
          availableModes: [
            { id: "plan", name: "Plan" },
            { id: "code", name: "Code" },
          ],
        },
      },
    } as never);
    render(<SessionView nodeId="n1" data={existing} />);
    await waitFor(async () => expect(await modeLabel()).toContain("Plan"));
    expect(inlineConfig()).toHaveLength(0);
    expect(document.querySelector("[data-slot=acp-effort-value]")).toBeNull();
  });
});
