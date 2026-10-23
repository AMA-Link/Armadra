import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { SubagentCardModel } from "@/agent/subagent-store";
import { usePreferencesStore } from "@/app/preferences-store";
import { installDomPolyfills } from "@/app/test-harness";
import { SubagentCard } from "./SubagentCard";

beforeAll(() => {
  installDomPolyfills();
  usePreferencesStore.setState({ locale: "zh-CN" });
});
afterEach(cleanup);

const base: SubagentCardModel = {
  id: "c1",
  parentId: "p",
  taskLabel: "评审改动",
  startedAt: Date.now(),
  state: "working",
};

describe("SubagentCard", () => {
  it("运行中：状态胶囊 + 任务名 + 计时，没有展开钮，也没有类型 / 用量胶囊", () => {
    const { container } = render(
      <SubagentCard card={{ ...base, type: "Explore" }} />,
    );
    const pill = container.querySelector("[data-slot=status-pill]")!;
    expect(pill.getAttribute("data-tone")).toBe("working");
    expect(pill.textContent).toBe("运行中");
    expect(screen.getByText("评审改动")).toBeTruthy();
    expect(screen.queryByText("Explore")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("[data-slot=subagent-usage]")).toBeNull();
  });

  it("完成：done 胶囊，tokens 与工具数合成一段等宽小字「1.2K · 3 次」", () => {
    const { container } = render(
      <SubagentCard
        card={{
          ...base,
          state: "done",
          durationMs: 7000,
          tokens: 1234,
          toolUses: 3,
          result: "结论",
        }}
      />,
    );
    expect(
      container
        .querySelector("[data-slot=status-pill]")!
        .getAttribute("data-tone"),
    ).toBe("done");
    expect(
      container.querySelector("[data-slot=subagent-usage]")!.textContent,
    ).toBe("1.2K · 3 次");
    expect(screen.getByText("0:07")).toBeTruthy();
  });

  it("只有一项时只写那一项", () => {
    const { container } = render(
      <SubagentCard card={{ ...base, state: "done", toolUses: 2 }} />,
    );
    expect(
      container.querySelector("[data-slot=subagent-usage]")!.textContent,
    ).toBe("2 次");
  });

  it("展开看结果；没有结果直说没有", () => {
    render(<SubagentCard card={{ ...base, state: "done", result: "结论" }} />);
    expect(screen.queryByText("结论")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开结果" }));
    expect(screen.getByText("结论")).toBeTruthy();
    cleanup();
    render(<SubagentCard card={{ ...base, state: "done" }} />);
    fireEvent.click(screen.getByRole("button", { name: "展开结果" }));
    expect(screen.getByText("没有返回结果")).toBeTruthy();
  });
});
