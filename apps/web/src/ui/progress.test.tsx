import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Progress, TICK_COUNT, progressToneFor } from "@/ui/progress";

afterEach(cleanup);

describe("Progress tone", () => {
  it("默认品牌色；warn / danger 只换指示条颜色", () => {
    const bar = (tone?: "warn" | "danger") => {
      const { container, unmount } = render(
        <Progress value={50} {...(tone ? { tone } : {})} />,
      );
      const root = container.firstElementChild as HTMLElement;
      const indicator = root.querySelector(
        '[data-slot="progress-indicator"]',
      ) as HTMLElement;
      const result = {
        tone: root.dataset.tone,
        indicator: indicator.className,
        track: root.className,
        move: indicator.style.transform,
      };
      unmount();
      return result;
    };
    const base = bar();
    const warn = bar("warn");
    const danger = bar("danger");
    expect(base).toMatchObject({ tone: "default", move: "translateX(-50%)" });
    expect(base.indicator).toContain("bg-primary");
    expect(warn.indicator).toContain("bg-warn");
    expect(danger.indicator).toContain("bg-danger");
    expect(warn.indicator).not.toContain("bg-primary");
    expect(warn.track).toBe(base.track);
  });
});

describe("Progress ticks（刻度条）", () => {
  const ticks = (container: HTMLElement) =>
    [
      ...container.querySelectorAll("[data-slot='progress-tick']"),
    ] as HTMLElement[];

  it("20 格，已填格数 = round(value / 5)，未填格是 --faint 30%", () => {
    const { container } = render(<Progress variant="ticks" value={82} />);
    expect(TICK_COUNT).toBe(20);
    expect(ticks(container)).toHaveLength(20);
    const filled = ticks(container).filter((t) => t.dataset.filled === "true");
    expect(filled).toHaveLength(16);
    expect(filled[0]!.className).toContain("bg-primary");
    const empty = ticks(container).find((t) => t.dataset.filled === "false")!;
    expect(empty.className).toContain("bg-faint/30");
    expect(ticks(container)[0]!.className).toContain("rounded-tight");
  });

  it("按 tone 着色，逐格点亮用 --i 错落", () => {
    const { container } = render(
      <Progress variant="ticks" value={100} tone="warn" />,
    );
    const all = ticks(container);
    expect(all.every((t) => t.className.includes("bg-warn"))).toBe(true);
    expect(all[3]!.style.getPropertyValue("--i")).toBe("3");
    expect(all[3]!.className).toContain("anim-tick-in");
  });

  it("仍是 progressbar，带 aria-valuenow；越界夹到 0–100", () => {
    const { container, rerender } = render(
      <Progress variant="ticks" value={40} />,
    );
    const bar = () =>
      container.querySelector("[role='progressbar']") as HTMLElement;
    expect(bar().getAttribute("aria-valuenow")).toBe("40");
    rerender(<Progress variant="ticks" value={142} />);
    expect(bar().getAttribute("aria-valuenow")).toBe("100");
    rerender(<Progress variant="ticks" value={-3} />);
    expect(bar().getAttribute("aria-valuenow")).toBe("0");
    expect(ticks(container).every((t) => t.dataset.filled === "false")).toBe(
      true,
    );
  });

  it("阈值色调：≥80 warn、≥95 danger", () => {
    expect(progressToneFor(0)).toBe("brand");
    expect(progressToneFor(79.9)).toBe("brand");
    expect(progressToneFor(80)).toBe("warn");
    expect(progressToneFor(94)).toBe("warn");
    expect(progressToneFor(95)).toBe("danger");
    expect(progressToneFor(142)).toBe("danger");
  });
});

describe("Progress bar 补充", () => {
  it("success 与 brand 两个 tone", () => {
    const indicator = (tone: "success" | "brand") => {
      const { container, unmount } = render(
        <Progress value={30} tone={tone} />,
      );
      const cls = container.querySelector(
        "[data-slot='progress-indicator']",
      )!.className;
      unmount();
      return cls;
    };
    expect(indicator("success")).toContain("bg-success");
    expect(indicator("brand")).toContain("bg-brand");
  });

  it("过渡只动 transform（点名属性，linear），不用 transition-all", () => {
    const { container } = render(<Progress value={30} />);
    const cls = container.querySelector(
      "[data-slot='progress-indicator']",
    )!.className;
    expect(cls).toContain("transition-transform");
    expect(cls).toContain("ease-linear");
    expect(cls).not.toContain("transition-all");
  });

  it("没有值 / NaN 是不确定进度：条匀速扫过，不渲染 NaN", () => {
    const { container, rerender } = render(<Progress />);
    const root = () => container.firstElementChild as HTMLElement;
    expect(root().getAttribute("data-state")).toBe("indeterminate");
    expect(
      container.querySelector("[data-slot='progress-indicator']")!.className,
    ).toContain("anim-indeterminate");
    rerender(<Progress value={Number.NaN} />);
    expect(root().getAttribute("data-state")).toBe("indeterminate");
    expect(root().getAttribute("aria-valuenow")).toBeNull();
  });
});
