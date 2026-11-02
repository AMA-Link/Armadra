import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const api = vi.hoisted(() => ({ drive: vi.fn() }));
vi.mock("./api", () => ({ acpApi: api }));

import { chooseOption } from "@/app/test-harness";
import { PromptBox } from "./PromptBox";

const onSubmit = vi.fn<(text: string) => Promise<boolean>>();
const onCancel = vi.fn();
const onMode = vi.fn();
const onModel = vi.fn();

const MODES = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Default" },
    { id: "plan", name: "Plan" },
  ],
};
const MODELS = {
  currentModelId: "small",
  availableModels: [
    { modelId: "small", name: "Small" },
    { modelId: "large", name: "Large" },
  ],
};

/** 让 `(max-width: 767px)` 命中（窄屏），测完还原。 */
function narrowViewport() {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    ...original(query),
    matches: query.includes("767"),
  })) as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

function renderBox(
  props: Partial<React.ComponentProps<typeof PromptBox>> = {},
) {
  return render(
    <PromptBox
      sessionId="s1"
      disabled={false}
      streaming={false}
      modes={null}
      onSubmit={onSubmit}
      onCancel={onCancel}
      onMode={onMode}
      {...props}
    />,
  );
}

beforeEach(() => {
  api.drive.mockReset().mockResolvedValue({});
  onSubmit.mockReset().mockResolvedValue(true);
  onCancel.mockReset();
  onMode.mockReset();
  onModel.mockReset();
});

afterEach(cleanup);

describe("PromptBox", () => {
  it("sends on Enter and keeps Shift+Enter for a new line", async () => {
    renderBox();
    const input = screen.getByLabelText("消息") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "第一行" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("第一行"));
    expect(input.value).toBe("");
  });

  it("does not send while an input method is composing", () => {
    renderBox();
    const input = screen.getByLabelText("消息");
    fireEvent.change(input, { target: { value: "ni" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps the text when sending fails", async () => {
    onSubmit.mockResolvedValue(false);
    renderBox();
    const input = screen.getByLabelText("消息") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(input.value).toBe("hello"));
  });

  it("takes the human lease on focus and gives it back on blur and submit", async () => {
    renderBox();
    const input = screen.getByLabelText("消息");
    fireEvent.focus(input);
    expect(api.drive).toHaveBeenLastCalledWith("s1", "takeover");
    fireEvent.blur(input);
    expect(api.drive).toHaveBeenLastCalledWith("s1", "release");

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "go" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(api.drive).toHaveBeenLastCalledWith("s1", "release");
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(api.drive.mock.calls).toEqual([
      ["s1", "takeover"],
      ["s1", "release"],
      ["s1", "takeover"],
      ["s1", "release"],
    ]);
  });

  it("releases the lease when unmounted while focused", () => {
    const { unmount } = renderBox();
    fireEvent.focus(screen.getByLabelText("消息"));
    unmount();
    expect(api.drive).toHaveBeenLastCalledWith("s1", "release");
  });

  it("turns the send button into stop during a turn, and Esc stops too", () => {
    renderBox({ streaming: true });
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByLabelText("消息"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("is disabled offline", () => {
    renderBox({ disabled: true });
    expect(
      (screen.getByLabelText("消息") as HTMLTextAreaElement).disabled,
    ).toBe(true);
  });

  it("offers a mode picker only when there is a choice", () => {
    const { rerender } = renderBox({
      modes: {
        currentModeId: "default",
        availableModes: [{ id: "default", name: "Default" }],
      },
    });
    expect(screen.queryByLabelText("模式")).toBeNull();
    rerender(
      <PromptBox
        sessionId="s1"
        disabled={false}
        streaming={false}
        modes={{
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "plan", name: "Plan" },
          ],
        }}
        onSubmit={onSubmit}
        onCancel={onCancel}
        onMode={onMode}
      />,
    );
    expect(screen.getByLabelText("模式")).toBeTruthy();
  });

  it("offers a model picker only when the agent gives a catalog", () => {
    const { rerender } = renderBox({ models: null, onModel });
    expect(screen.queryByLabelText("模型")).toBeNull();
    rerender(
      <PromptBox
        sessionId="s1"
        disabled={false}
        streaming={false}
        modes={null}
        models={MODELS}
        onSubmit={onSubmit}
        onCancel={onCancel}
        onMode={onMode}
        onModel={onModel}
      />,
    );
    const trigger = screen.getByLabelText("模型");
    expect(trigger.textContent).toContain("Small");
  });

  it("keeps mode and model on the action row on a narrow screen, with no more menu", async () => {
    const restore = narrowViewport();
    try {
      renderBox({ modes: MODES, models: MODELS, onModel });
      expect(screen.queryByRole("button", { name: "更多" })).toBeNull();
      // 窄屏模式换成下拉，不是分段控件。
      expect(screen.getByLabelText("模式").getAttribute("data-slot")).toBe(
        "select-trigger",
      );
      const model = screen.getByLabelText("模型");
      fireEvent.pointerDown(model, { button: 0, pointerType: "mouse" });
      fireEvent.click(
        await screen.findByRole("menuitemradio", { name: "Large" }),
      );
      expect(onModel).toHaveBeenCalledWith("large");
      // 发送只剩图标。
      expect(
        screen.getByRole("button", { name: "发送" }).getAttribute("data-size"),
      ).toBe("icon-sm");
    } finally {
      restore();
    }
  });

  it("lays the composer out as two rows: the input above, the actions below", () => {
    renderBox({ modes: MODES, models: MODELS, onModel });
    const composer = document.querySelector("[data-slot=acp-composer]")!;
    const input = screen.getByLabelText("消息");
    const actions = composer.querySelector("[data-slot=acp-composer-actions]")!;
    expect(input.parentElement).toBe(composer);
    expect(actions.parentElement).toBe(composer);
    expect(
      input.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(actions.contains(screen.getByLabelText("模式"))).toBe(true);
    expect(actions.contains(screen.getByLabelText("模型"))).toBe(true);
    expect(actions.contains(screen.getByRole("button", { name: "发送" }))).toBe(
      true,
    );
  });

  it("fills the box from an edit-and-resend without sending, cursor at the end", async () => {
    const { rerender } = renderBox({ prefill: { text: "try again", seq: 1 } });
    const input = screen.getByLabelText("消息") as HTMLTextAreaElement;
    await waitFor(() => expect(input.value).toBe("try again"));
    expect(document.activeElement).toBe(input);
    expect(onSubmit).not.toHaveBeenCalled();
    // 同一句再填一次（seq 变了）也照样填进来。
    fireEvent.change(input, { target: { value: "" } });
    rerender(
      <PromptBox
        sessionId="s1"
        disabled={false}
        streaming={false}
        modes={null}
        onSubmit={onSubmit}
        onCancel={onCancel}
        onMode={onMode}
        prefill={{ text: "try again", seq: 2 }}
      />,
    );
    await waitFor(() => expect(input.value).toBe("try again"));
  });

  it("shows context usage and turns to the warning colour near the limit", () => {
    renderBox({ usage: { used: 12_300, size: 200_000 } });
    const usage = document.querySelector("[data-slot=acp-usage]")!;
    // 数字按界面语言紧凑写（中文是「万」）。
    expect(usage.textContent).toBe("1.2万 / 20万");
    expect(usage.getAttribute("data-warn")).toBeNull();
    cleanup();
    renderBox({ usage: { used: 190, size: 200 } });
    expect(
      document
        .querySelector("[data-slot=acp-usage]")
        ?.getAttribute("data-warn"),
    ).toBe("true");
  });

  it("moves through slash commands with the arrow keys", () => {
    Element.prototype.scrollIntoView ??= () => undefined;
    renderBox({
      commands: [
        { name: "review", description: "" },
        { name: "init", description: "" },
      ],
    });
    const input = screen.getByLabelText("消息") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "/" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input.value).toBe("/init ");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows a command's input hint in the list and as the placeholder after choosing it", () => {
    Element.prototype.scrollIntoView ??= () => undefined;
    renderBox({
      commands: [
        { name: "web", description: "search", hint: "query to search" },
        { name: "init", description: "" },
      ],
    });
    const input = screen.getByLabelText("消息") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "/w" } });
    expect(
      document.querySelector("[data-slot=acp-command-hint]")?.textContent,
    ).toBe("query to search");
    expect(input.placeholder).toBe("");
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input.value).toBe("/web ");
    expect(input.placeholder).toBe("query to search");
    fireEvent.change(input, { target: { value: "/web cats" } });
    expect(input.placeholder).toBe("");
  });

  describe("config options beyond model and mode", () => {
    const EFFORT = {
      id: "effort",
      name: "Effort",
      category: "thought_level",
      type: "select" as const,
      currentValue: "low",
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    };
    const THINK = {
      id: "think",
      name: "Think",
      type: "boolean" as const,
      currentValue: false,
      options: [],
    };
    const onConfig = vi.fn();
    beforeEach(() => onConfig.mockReset());
    const openModel = () =>
      fireEvent.pointerDown(screen.getByLabelText("模型"), {
        button: 0,
        pointerType: "mouse",
      });

    it("folds the thinking level into the model picker as one control", async () => {
      renderBox({ models: MODELS, onModel, configOptions: [EFFORT], onConfig });
      const trigger = screen.getByLabelText("模型");
      expect(trigger.textContent).toContain("Small");
      expect(trigger.textContent).toContain("Low");
      // 没有单独的强度控件。
      expect(screen.queryByLabelText("Effort")).toBeNull();
      openModel();
      const high = await screen.findByRole("menuitemradio", { name: "High" });
      expect(
        screen
          .getByRole("menuitemradio", { name: "Low" })
          .getAttribute("aria-checked"),
      ).toBe("true");
      fireEvent.click(high);
      expect(onConfig).toHaveBeenCalledWith("effort", "high");
    });

    it("keeps the menu open after picking a model so its level can follow", async () => {
      renderBox({ models: MODELS, onModel, configOptions: [EFFORT], onConfig });
      openModel();
      fireEvent.click(
        await screen.findByRole("menuitemradio", { name: "Large" }),
      );
      expect(onModel).toHaveBeenCalledWith("large");
      expect(screen.getByRole("menu")).toBeTruthy();
      expect(screen.getByRole("menuitemradio", { name: "High" })).toBeTruthy();
    });

    it("shows the level alone when there is no model catalog", async () => {
      renderBox({ configOptions: [EFFORT], onConfig });
      expect(screen.queryByLabelText("模型")).toBeNull();
      const trigger = screen.getByLabelText("思考强度");
      expect(trigger.textContent).toContain("Low");
      fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
      fireEvent.click(
        await screen.findByRole("menuitemradio", { name: "High" }),
      );
      expect(onConfig).toHaveBeenCalledWith("effort", "high");
    });

    it("recognises a level by its id when the agent gives no category", () => {
      renderBox({
        models: MODELS,
        onModel,
        configOptions: [
          { ...EFFORT, id: "reasoning_effort", category: undefined },
        ],
        onConfig,
      });
      expect(screen.getByLabelText("模型").textContent).toContain("Low");
    });

    it("puts other options straight on the action row: a select and a toggle", async () => {
      const STYLE = {
        id: "style",
        name: "Style",
        type: "select" as const,
        currentValue: "brief",
        options: [
          { value: "brief", name: "Brief" },
          { value: "full", name: "Full" },
        ],
      };
      renderBox({ configOptions: [STYLE, THINK], onConfig });
      const think = screen.getByRole("button", { name: "Think" });
      expect(think.getAttribute("aria-pressed")).toBe("false");
      fireEvent.click(think);
      expect(onConfig).toHaveBeenCalledWith("think", true);
      await chooseOption(screen.getByLabelText("Style"), "Full");
      expect(onConfig).toHaveBeenCalledWith("style", "full");
      expect(screen.queryByRole("button", { name: "更多" })).toBeNull();
    });

    it("keeps everything on the action row on a narrow screen too", () => {
      const restore = narrowViewport();
      try {
        renderBox({
          modes: MODES,
          models: MODELS,
          onModel,
          configOptions: [EFFORT, THINK],
          onConfig,
        });
        expect(screen.queryByRole("button", { name: "更多" })).toBeNull();
        expect(screen.getByLabelText("模型").textContent).toContain("Low");
        expect(screen.getByRole("button", { name: "Think" })).toBeTruthy();
        expect(screen.getByLabelText("模式")).toBeTruthy();
      } finally {
        restore();
      }
    });

    it("draws nothing extra without config options", () => {
      renderBox({ onConfig });
      expect(
        document.querySelector(
          "[data-slot=acp-config-select], [data-slot=acp-config-toggle], [data-slot=acp-model-effort]",
        ),
      ).toBeNull();
    });
  });

  it("draws the context as a 20-cell tick bar whose tone follows 80% and 95%", () => {
    const cells = () =>
      document.querySelectorAll(
        "[data-slot=acp-usage] [data-slot=progress-tick]",
      );
    const trigger = () => document.querySelector("[data-slot=acp-usage]")!;
    renderBox({ usage: { used: 50, size: 100 } });
    expect(cells()).toHaveLength(20);
    expect(
      document.querySelectorAll(
        "[data-slot=acp-usage] [data-slot=progress-tick][data-filled=true]",
      ),
    ).toHaveLength(10);
    expect(trigger().getAttribute("data-tone")).toBe("brand");
    expect(trigger().getAttribute("data-warn")).toBeNull();
    cleanup();
    renderBox({ usage: { used: 80, size: 100 } });
    expect(trigger().getAttribute("data-tone")).toBe("warn");
    expect(trigger().getAttribute("data-warn")).toBe("true");
    cleanup();
    renderBox({ usage: { used: 94, size: 100 } });
    expect(trigger().getAttribute("data-tone")).toBe("warn");
    cleanup();
    renderBox({ usage: { used: 95, size: 100 } });
    expect(trigger().getAttribute("data-tone")).toBe("danger");
    cleanup();
    // 溢出与零总量不画成 NaN。
    renderBox({ usage: { used: 500, size: 100 } });
    expect(cells()).toHaveLength(20);
    expect(trigger().textContent).toBe("500 / 100");
  });

  it("opens the context popover: big number, remaining, cost, percent", async () => {
    renderBox({
      usage: {
        used: 183_400,
        size: 200_000,
        cost: { amount: 1.5, currency: "USD" },
      },
    });
    fireEvent.click(document.querySelector("[data-slot=acp-usage]")!);
    const popover = await waitFor(() => {
      const node = document.querySelector("[data-slot=acp-usage-popover]");
      expect(node).toBeTruthy();
      return node as HTMLElement;
    });
    expect(popover.textContent).toContain("18.3万");
    expect(popover.textContent).toContain("92%");
    expect(popover.textContent).toContain("$1.50");
    const remaining = popover.querySelector("[data-slot=acp-usage-remaining]")!;
    expect(remaining.textContent).toBe("剩余 1.7万");
    // ≥80% 剩余用警示文字色
    expect(remaining.className).toContain("text-warn-text");
  });

  it("offers Compact only when the agent has the command, and sends it", async () => {
    renderBox({
      usage: { used: 10, size: 100 },
      commands: [{ name: "review", description: "" }],
    });
    fireEvent.click(document.querySelector("[data-slot=acp-usage]")!);
    await screen.findByText(/剩余/);
    expect(document.querySelector("[data-slot=acp-usage-compact]")).toBeNull();
    cleanup();

    renderBox({
      usage: { used: 10, size: 100 },
      commands: [{ name: "compact", description: "" }],
    });
    fireEvent.click(document.querySelector("[data-slot=acp-usage]")!);
    const compact = await screen.findByRole("button", { name: "压缩" });
    fireEvent.click(compact);
    expect(onSubmit).toHaveBeenCalledWith("/compact");
  });

  it("disables Compact while a turn is running", async () => {
    renderBox({
      streaming: true,
      usage: { used: 10, size: 100 },
      commands: [{ name: "compact", description: "" }],
    });
    fireEvent.click(document.querySelector("[data-slot=acp-usage]")!);
    const compact = (await screen.findByRole("button", {
      name: "压缩",
    })) as HTMLButtonElement;
    expect(compact.disabled).toBe(true);
  });

  it("puts every control on the 28px tier of the action row with the Enter / Esc hints on the send button", () => {
    renderBox({
      modes: MODES,
      models: MODELS,
      onModel,
      usage: { used: 1, size: 2 },
    });
    expect(screen.getByLabelText("模型").getAttribute("data-size")).toBe("sm");
    const send = screen.getByRole("button", { name: "发送" });
    expect(send.getAttribute("data-size")).toBe("sm");
    expect(send.querySelector("[data-slot=kbd]")?.textContent).toBe("↵");
    expect(send.getAttribute("aria-keyshortcuts")).toBe("Enter");
    cleanup();
    renderBox({ streaming: true });
    const stop = screen.getByRole("button", { name: "停止" });
    expect(stop.querySelector("[data-slot=kbd]")?.textContent).toBe("Esc");
  });

  it("draws the mode as a segmented control when there are few short modes", () => {
    renderBox({ modes: MODES });
    const list = screen.getByLabelText("模式");
    expect(list.getAttribute("data-variant")).toBe("segmented");
    expect(
      [...list.querySelectorAll("[role=tab]")].map((tab) => tab.textContent),
    ).toEqual(["Default", "Plan"]);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Plan" }));
    expect(onMode).toHaveBeenCalledWith("plan");
    cleanup();
    // 名字长或模式多：回落到 Select。
    renderBox({
      modes: {
        currentModeId: "a",
        availableModes: [
          { id: "a", name: "Accept edits and run" },
          { id: "b", name: "Plan" },
        ],
      },
    });
    expect(screen.getByLabelText("模式").getAttribute("data-slot")).toBe(
      "select-trigger",
    );
    cleanup();
    renderBox({
      modes: {
        currentModeId: "a",
        availableModes: ["a", "b", "c", "d"].map((id) => ({ id, name: id })),
      },
    });
    expect(screen.getByLabelText("模式").getAttribute("data-slot")).toBe(
      "select-trigger",
    );
  });
});
