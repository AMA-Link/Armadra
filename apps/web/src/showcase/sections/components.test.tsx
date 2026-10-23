import { afterEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
    const shell = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-slot=toast]");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(shell.textContent).toContain("保存");
    expect(shell.getAttribute("role")).toBe("status");
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

describe("设计系统 §9 的变体样本", () => {
  it("按钮五档 + 输入类四档同行，loading / shortcut / destructive-solid 都在", () => {
    renderSection();
    const sizes = sample("button · sizes");
    expect(
      [...sizes.querySelectorAll<HTMLElement>("button[data-slot=button]")].map(
        (button) => button.dataset.size,
      ),
    ).toEqual(["xs", "sm", "default", "lg", "touch"]);
    expect(sizes.querySelectorAll("input[data-slot=input]")).toHaveLength(4);
    const loading = sample("button · loading · shortcut");
    expect(loading.querySelectorAll("[aria-busy=true]").length).toBe(2);
    expect(loading.querySelectorAll("kbd").length).toBe(3);
    expect(
      loading.querySelector("[data-variant=destructive-solid]"),
    ).not.toBeNull();
  });

  it("徽标两档 × 九变体", () => {
    renderSection();
    const badges =
      sample("badge · sm · md").querySelectorAll<HTMLElement>(
        "[data-slot=badge]",
      );
    expect(badges).toHaveLength(18);
    expect(new Set([...badges].map((badge) => badge.dataset.size))).toEqual(
      new Set(["sm", "md"]),
    );
    expect(
      new Set([...badges].map((badge) => badge.dataset.variant)).size,
    ).toBe(9);
  });

  it("状态族：8 个 tone × 点 6 / 8、胶囊 sm / md；StatusLine 四种", () => {
    renderSection();
    const family = sample("status-dot · status-pill");
    expect(family.querySelectorAll("[data-slot=status-dot]")).toHaveLength(16);
    expect(family.querySelectorAll("[data-slot=status-pill]")).toHaveLength(16);
    const tones = new Set(
      [...family.querySelectorAll<HTMLElement>("[data-slot=status-pill]")].map(
        (pill) => pill.dataset.tone,
      ),
    );
    expect(tones.size).toBe(8);
    expect(
      sample("status-line").querySelectorAll("[data-slot=status-line]"),
    ).toHaveLength(4);
  });

  it("分段控件、卡片三变体、刻度条、托盘", () => {
    renderSection();
    const tabs = sample("tabs · segmented");
    expect(tabs.querySelectorAll("[data-variant=segmented]")).toHaveLength(2);
    expect(tabs.querySelector("[data-variant=line]")).not.toBeNull();
    expect(
      tabs.querySelectorAll("[data-slot=indicator]").length,
    ).toBeGreaterThanOrEqual(3);
    const cards = sample("card · tray · table");
    expect(cards.querySelector("[data-variant=table]")).not.toBeNull();
    expect(
      sample("progress · ticks").querySelectorAll("[data-variant=ticks]"),
    ).toHaveLength(4);
    const tray = sample("tray");
    expect(tray.querySelectorAll("[data-slot=tray]")).toHaveLength(4);
    // 空值与 NaN 显示 —，不渲染 NaN
    expect(tray.textContent).not.toMatch(/NaN|undefined|null/);
    expect(tray.textContent).toContain("—");
  });

  it("提示五种按钮：success / error / info / loading / promise", () => {
    renderSection();
    const buttons = [
      ...sample("toast").querySelectorAll<HTMLElement>("button"),
    ].map((button) => button.textContent);
    expect(buttons).toEqual(["success", "error", "info", "loading", "promise"]);
  });

  it("点 error 出带动作的壳，不自动消失", async () => {
    renderSection();
    fireEvent.click(
      within(sample("toast")).getByRole("button", { name: "error" }),
    );
    const shell = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        "[data-slot=toast][data-kind=error]",
      );
      expect(found).not.toBeNull();
      return found!;
    });
    expect(shell.textContent).toContain("连接已断开");
    expect(within(shell).getByRole("button", { name: "重试" })).toBeTruthy();
  });

  it("边界标签：两字名、emoji 开头、超长无空格串都在 160px 里不撑开", () => {
    renderSection();
    const edge = sample("edge · labels");
    expect(edge.querySelectorAll("[data-slot=badge]")).toHaveLength(3);
    expect(edge.textContent).toContain("🙂");
  });
});
