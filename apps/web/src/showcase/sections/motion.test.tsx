import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import { installDomPolyfills } from "@/app/test-harness";
import { ShowcaseProviders } from "../harness";
import { CHECK_SPIN_MS, MOTION_RECIPES } from "../fixtures/motion";
import MotionSection from "./motion";

beforeAll(installDomPolyfills);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderMotion() {
  return render(
    <ShowcaseProviders>
      <MotionSection />
    </ShowcaseProviders>,
  );
}

const cell = (recipe: string) =>
  document.querySelector(`[data-motion-cell="${recipe}"]`) as HTMLElement;

describe("motion 分区（设计系统 §8）", () => {
  it("十个配方各一格，顺序固定，每格都有重放", () => {
    renderMotion();
    const cells = [...document.querySelectorAll("[data-motion-cell]")].map(
      (node) => (node as HTMLElement).dataset.motionCell,
    );
    expect(cells).toEqual([...MOTION_RECIPES]);
    expect(cells).toEqual([
      "press",
      "pop",
      "indicator",
      "text-swap",
      "number-roll",
      "list-stagger",
      "icon-swap",
      "shake",
      "shimmer",
      "check-draw",
    ]);
    for (const recipe of MOTION_RECIPES) {
      expect(
        cell(recipe).querySelector(`[data-sample="${recipe}"]`),
      ).not.toBeNull();
      expect(cell(recipe).querySelector("button[aria-label]")).not.toBeNull();
    }
  });

  it("按下：活的按钮 + 一帧强制的按下态（scale 取令牌）", () => {
    renderMotion();
    const forced = cell("press").querySelector(
      '[data-forced="pressed"]',
    ) as HTMLElement;
    expect(forced.style.transform).toBe("scale(var(--press-scale))");
  });

  it("发芽：菜单类与 Tooltip 用 motion-pop / motion-tip 工具类，旁边有起始帧", () => {
    renderMotion();
    const pop = cell("pop");
    expect(pop.querySelector(".motion-pop[data-state='open']")).not.toBeNull();
    expect(pop.querySelector(".motion-tip[data-state='open']")).not.toBeNull();
    const start = pop.querySelector('[data-forced="start"]') as HTMLElement;
    expect(start.style.transform).toBe("scale(var(--pop-scale))");
  });

  it("指示器平移：点哪项哪项是当前项，指示器只有一块", () => {
    renderMotion();
    const tabs = [
      ...cell("indicator").querySelectorAll("button[data-active], button"),
    ].filter((node) => node.textContent !== "");
    const active = () =>
      cell("indicator").querySelector<HTMLElement>(
        "button[data-active='true']",
      );
    expect(active()?.textContent).toBe("列表");
    fireEvent.click(tabs.find((node) => node.textContent === "画布")!);
    expect(active()?.textContent).toBe("画布");
    expect(
      cell("indicator").querySelectorAll(
        '[data-slot="indicator"][data-kind="active"]',
      ),
    ).toHaveLength(1);
  });

  it("文字替换：点一下「复制」换成「已复制」", () => {
    renderMotion();
    const swap = cell("text-swap");
    expect(swap.textContent).toContain("复制");
    fireEvent.click(swap.querySelector("button:not([aria-label])")!);
    expect(swap.querySelector('[data-slot="text-swap-new"]')?.textContent).toBe(
      "已复制",
    );
  });

  it("数字滚动：等宽数字，来回两个值", () => {
    renderMotion();
    const roll = cell("number-roll");
    expect(roll.querySelector("[data-numeric]")).not.toBeNull();
    expect(roll.querySelectorAll("button")).toHaveLength(2);
  });

  it("列表错落：六行，--i 依次 0–5，用 motion-enter-list", () => {
    renderMotion();
    const rows = [...cell("list-stagger").querySelectorAll<HTMLElement>("li")];
    expect(rows).toHaveLength(6);
    rows.forEach((row, index) => {
      expect(row.classList.contains("motion-enter-list")).toBe(true);
      expect(row.style.getPropertyValue("--i")).toBe(String(index));
    });
  });

  it("重放整格重新挂载：列表行是新节点，动画从头播", () => {
    renderMotion();
    const before = cell("list-stagger").querySelector("li");
    fireEvent.click(cell("list-stagger").querySelector("button[aria-label]")!);
    const after = cell("list-stagger").querySelector("li");
    expect(after).not.toBe(before);
    expect(after).not.toBeNull();
  });

  it("图标切换：两枚图标都在 DOM 里，点一下换谁隐藏；减少动效下只留透明度", () => {
    renderMotion();
    const swap = cell("icon-swap");
    const button = swap.querySelector("button[aria-pressed]") as HTMLElement;
    const [copy, check] = [...button.querySelectorAll("svg")];
    expect(copy!.getAttribute("class")).not.toContain("opacity-0");
    expect(check!.getAttribute("class")).toContain("opacity-0");
    expect(check!.getAttribute("class")).toContain("motion-reduce:scale-100");
    expect(check!.getAttribute("class")).toContain("duration-(--dur-base)");
    fireEvent.click(button);
    expect(copy!.getAttribute("class")).toContain("opacity-0");
    expect(check!.getAttribute("class")).not.toContain("opacity-0");
  });

  it("shake：输入框带 aria-invalid（样式层在挂载时抖两次），重放换新节点", () => {
    renderMotion();
    const input = cell("shake").querySelector("input") as HTMLInputElement;
    expect(input.getAttribute("aria-invalid")).toBe("true");
    fireEvent.click(cell("shake").querySelector("button[aria-label]")!);
    expect(cell("shake").querySelector("input")).not.toBe(input);
  });

  it("shimmer：一行在扫，一行静止", () => {
    renderMotion();
    const shimmers = [
      ...cell("shimmer").querySelectorAll('[data-slot="shimmer"]'),
    ];
    expect(shimmers.map((node) => node.getAttribute("data-active"))).toEqual([
      "true",
      "false",
    ]);
    expect(shimmers[0]!.className).toContain("anim-shimmer");
    expect(shimmers[1]!.className).not.toContain("anim-shimmer");
  });

  it("对勾画出：第一次静止转圈；重放后转一会儿收成对勾（路径画出），旁边有终态 done / failed", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    renderMotion();
    const states = () =>
      [...cell("check-draw").querySelectorAll('[data-slot="spinner"]')].map(
        (node) => node.getAttribute("data-state"),
      );
    expect(states()).toEqual(["spinning", "done", "failed"]);
    act(() => void vi.advanceTimersByTime(CHECK_SPIN_MS * 2));
    expect(states()).toEqual(["spinning", "done", "failed"]);

    fireEvent.click(cell("check-draw").querySelector("button[aria-label]")!);
    expect(states()).toEqual(["spinning", "done", "failed"]);
    act(() => void vi.advanceTimersByTime(CHECK_SPIN_MS));
    expect(states()).toEqual(["done", "done", "failed"]);
    expect(cell("check-draw").querySelector(".anim-check-draw")).not.toBeNull();
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });
});
