import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AnimatedNumber } from "@/ui/animated-number";
import { Progress } from "@/ui/progress";
import { Tray, TrayCard, TrayHeader, TrayTrend, TrayValue } from "@/ui/tray";

afterEach(cleanup);

describe("Tray（KPI 托盘，设计系统 §3.3）", () => {
  it("外层 panel + 1px 边 + rounded-float + p-1.5；内卡是 Card variant=tray", () => {
    render(
      <Tray data-testid="tray">
        <TrayHeader
          icon={<svg />}
          label="Claude"
          actions={<button>⋯</button>}
        />
        <TrayCard data-testid="card">
          <TrayValue label="Claude" value={82} format={(v) => `${v}%`} />
        </TrayCard>
      </Tray>,
    );
    const tray = screen.getByTestId("tray");
    expect(tray.className).toContain("bg-panel");
    expect(tray.className).toContain("border-border");
    expect(tray.className).toContain("rounded-float");
    expect(tray.className).toContain("p-1.5");
    const card = screen.getByTestId("card");
    expect(card.dataset.variant).toBe("tray");
    expect(card.dataset.slot).toBe("tray-card");
    expect(card.className).toContain("rounded-card");
    // Card 自己只给上下 12，左右由 TrayCard 补齐，内容不贴内卡边缘
    expect(card.className).toContain("px-3");
  });

  it("头：图标 14 + text-meta 标签 + 右侧动作槽，24 高", () => {
    render(
      <TrayHeader
        data-testid="header"
        icon={<svg />}
        label="Claude"
        actions={<button>⋯</button>}
      />,
    );
    const header = screen.getByTestId("header");
    expect(header.className).toContain("h-6");
    expect(header.className).toContain("text-meta");
    expect(header.className).toContain("size-3.5");
    expect(screen.getByText("Claude")).not.toBeNull();
    expect(screen.getByRole("button", { name: "⋯" })).not.toBeNull();
  });

  it("大数字外包 dl / dt / dd，dt 只给读屏；text-display 等宽", () => {
    render(<TrayValue label="已用" value={82} format={(v) => `${v}%`} />);
    const dd = document.querySelector("dd")!;
    expect(dd.className).toContain("text-display");
    expect(dd.className).toContain("font-mono");
    const dt = document.querySelector("dt")!;
    expect(dt.textContent).toBe("已用");
    expect(dt.className).toContain("sr-only");
    expect(dt.closest("dl")).toBe(dd.closest("dl"));
  });

  it.each([
    [null, "—"],
    [undefined, "—"],
    [Number.NaN, "—"],
    [Number.POSITIVE_INFINITY, "—"],
    ["", "—"],
    ["v0.10.0", "v0.10.0"],
  ] as const)(
    "值 %s 显示 %s，不渲染 NaN / null / undefined",
    (value, shown) => {
      render(<TrayValue label="值" value={value} />);
      expect(document.querySelector("dd")!.textContent).toBe(shown);
    },
  );

  it("数字走千分位", () => {
    render(<TrayValue label="值" value={1284} fromZero={false} />);
    expect(document.querySelector("dd")!.textContent).toBe(
      new Intl.NumberFormat().format(1284),
    );
  });

  it("内卡里可以放刻度条", () => {
    const { container } = render(
      <TrayCard>
        <Progress variant="ticks" value={50} />
      </TrayCard>,
    );
    expect(
      container.querySelectorAll("[data-slot='progress-tick']"),
    ).toHaveLength(20);
  });
});

describe("TrayTrend", () => {
  it("涨：success 文字色 + 正号；跌：danger + 负号；箭头 aria-hidden", () => {
    const { container, rerender } = render(<TrayTrend delta={15.2} />);
    const el = () =>
      container.querySelector("[data-slot='tray-trend']") as HTMLElement;
    expect(el().className).toContain("text-success-text");
    expect(el().textContent).toBe("+15.2%");
    expect(el().dataset.direction).toBe("up");
    expect(el().querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    rerender(<TrayTrend delta={-3} />);
    expect(el().className).toContain("text-danger-text");
    expect(el().textContent).toBe("−3%");
  });

  it("invert：费用上涨是坏事", () => {
    const { container } = render(<TrayTrend delta={8} invert />);
    expect(container.firstElementChild!.className).toContain(
      "text-danger-text",
    );
  });

  it.each([null, undefined, Number.NaN])(
    "没有可比的上一周期（%s）不画",
    (delta) => {
      const { container } = render(<TrayTrend delta={delta} />);
      expect(container.firstChild).toBeNull();
    },
  );
});

describe("AnimatedNumber", () => {
  it("默认首次直接显示目标值；等宽数字标 data-numeric", () => {
    const { container } = render(
      <AnimatedNumber value={42} format={(v) => `${Math.round(v)} 次`} />,
    );
    expect(container.textContent).toBe("42 次");
    expect(container.firstElementChild!.hasAttribute("data-numeric")).toBe(
      true,
    );
  });

  it("fromZero：第一帧从 0 起", () => {
    const { container } = render(
      <AnimatedNumber
        value={42}
        fromZero
        format={(v) => String(Math.round(v))}
      />,
    );
    expect(container.textContent).toBe("0");
  });

  it("面板侧的旧路径继续导出同一个组件", async () => {
    const legacy = await import("@/panels/usage/AnimatedNumber");
    expect(legacy.AnimatedNumber).toBe(AnimatedNumber);
  });
});
