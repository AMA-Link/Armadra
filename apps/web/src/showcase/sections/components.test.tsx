import { afterEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";

import { installDomPolyfills } from "@/app/test-harness";
import { ShowcaseProviders } from "../harness";
import ComponentsSection from "./components";

/**
 * 组件分区里设计展示页 §3 曾记为「未补」的四个样本：`resizable`、`chart`、
 * `sonner`、`context-menu`。截图矩阵只看得到它们画出来了，这里核对它们真是
 * 那几个组件、点了有反应。
 */

afterEach(cleanup);

function sample(name: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-sample="${name}"]`);
  if (found === null) throw new Error(`no sample ${name}`);
  return found;
}

function renderSection() {
  installDomPolyfills();
  render(
    <ShowcaseProviders>
      <ComponentsSection />
    </ShowcaseProviders>,
  );
}

describe("组件分区的 resizable、chart、sonner、context-menu 样本", () => {
  it("resizable：两块面板夹一个可拖的分隔条", () => {
    renderSection();
    const resizable = sample("resizable");
    expect(
      resizable.querySelector("[data-slot=resizable-panel-group]"),
    ).not.toBeNull();
    expect(
      resizable.querySelectorAll("[data-slot=resizable-panel]"),
    ).toHaveLength(2);
    expect(
      resizable.querySelector("[data-slot=resizable-handle]"),
    ).not.toBeNull();
  });

  it("chart：用 ChartContainer 画，带图表配置的颜色变量", () => {
    renderSection();
    const container =
      sample("chart").querySelector<HTMLElement>("[data-slot=chart]");
    expect(container).not.toBeNull();
    expect(container!.innerHTML).toContain("--color-tokens");
  });

  it("sonner：点按钮出一条提示", async () => {
    renderSection();
    const toasts = sample("sonner · context-menu");
    fireEvent.click(
      within(toasts).getAllByRole("button", { name: "保存" })[0]!,
    );
    expect(
      await screen.findByText("保存", { selector: "[data-title]" }),
    ).toBeTruthy();
  });

  it("context-menu：右键触发区出菜单，末项是危险操作", async () => {
    renderSection();
    const trigger = sample("sonner · context-menu").querySelector<HTMLElement>(
      "[data-slot=context-menu-trigger]",
    );
    expect(trigger).not.toBeNull();
    fireEvent.contextMenu(trigger!);
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "详情",
      "保存",
      "删除",
    ]);
    expect(items.at(-1)?.getAttribute("data-variant")).toBe("destructive");
  });
});
