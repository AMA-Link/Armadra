import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Badge } from "@/ui/badge";
import {
  STATUS_PILL_PULSES,
  STATUS_PILL_TEXT,
  StatusDot,
  StatusLine,
  StatusPill,
  TONE_COLOR,
  type StatusTone,
} from "@/ui/status-pill";
import { TextSwap } from "@/ui/text-swap";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const TONES = Object.keys(TONE_COLOR) as StatusTone[];

describe("状态族：三种形态共享同一张映射（设计系统 §11.1）", () => {
  it("八个 tone 都有图形色、文字色、脉冲默认值", () => {
    expect(TONES.sort()).toEqual(
      [
        "attention",
        "done",
        "failed",
        "idle",
        "paused",
        "queued",
        "unread",
        "working",
      ].sort(),
    );
    for (const tone of TONES) {
      expect(TONE_COLOR[tone]).toMatch(/^var\(--/);
      expect(STATUS_PILL_TEXT[tone]).toMatch(/^--/);
      expect(typeof STATUS_PILL_PULSES[tone]).toBe("boolean");
    }
    // 完成走 --status-done，而不是功能代码直接写 --success
    expect(TONE_COLOR.done).toBe("var(--status-done)");
  });

  it.each(TONES)("%s：Dot 与 Pill 的圆点同色、同脉冲", (tone) => {
    const { container } = render(
      <>
        <StatusDot tone={tone} label="x" data-testid="dot" />
        <StatusPill tone={tone} label="文案" />
      </>,
    );
    const dot = container.querySelector("[data-slot='status-dot']")!;
    const pillDot = container.querySelector("[data-slot='status-pill-dot']")!;
    expect((dot as HTMLElement).style.backgroundColor).toBe(
      (pillDot as HTMLElement).style.backgroundColor,
    );
    expect(dot.className.includes("anim-dot-pulse")).toBe(
      pillDot.className.includes("anim-dot-pulse"),
    );
    expect(dot.getAttribute("data-tone")).toBe(tone);
  });
});

describe("StatusDot", () => {
  it("点径 6 / 8，默认 8", () => {
    const { container, rerender } = render(<StatusDot tone="working" />);
    const dot = () =>
      container.querySelector("[data-slot='status-dot']") as HTMLElement;
    expect(dot().className).toContain("size-2");
    expect(dot().dataset.size).toBe("8");
    rerender(<StatusDot tone="working" size={6} />);
    expect(dot().className).toContain("size-[6px]");
  });

  it("有 label 是 role=img + aria-label；没有就是装饰，且不再用原生 title", () => {
    const { container, rerender } = render(
      <StatusDot tone="failed" label="本轮失败" />,
    );
    const dot = () =>
      container.querySelector("[data-slot='status-dot']") as HTMLElement;
    expect(screen.getByRole("img", { name: "本轮失败" })).toBe(dot());
    expect(dot().getAttribute("title")).toBeNull();
    rerender(<StatusDot tone="failed" />);
    expect(dot().getAttribute("aria-hidden")).toBe("true");
    expect(dot().getAttribute("role")).toBeNull();
  });

  it("corner 贴右上角带 2px --panel 环；color 盖过 tone；pulse 可显式关", () => {
    const { container } = render(
      <StatusDot tone="working" corner color="var(--member-2)" pulse={false} />,
    );
    const dot = container.querySelector(
      "[data-slot='status-dot']",
    ) as HTMLElement;
    expect(dot.className).toContain("absolute");
    expect(dot.className).toContain("ring-2");
    expect(dot.className).toContain("ring-panel");
    expect(dot.className).not.toContain("anim-dot-pulse");
    expect(dot.style.backgroundColor).toBe("var(--member-2)");
  });

  it("idle 画成暗点，不再返回 null", () => {
    const { container } = render(<StatusDot tone="idle" />);
    expect(container.querySelector("[data-slot='status-dot']")).not.toBeNull();
  });
});

describe("StatusPill", () => {
  it("sm 18 / md 20，与同尺寸的 Badge 同高", () => {
    render(
      <>
        <StatusPill tone="done" label="sm" />
        <StatusPill tone="done" label="md" size="md" />
        <Badge size="sm">b-sm</Badge>
      </>,
    );
    const height = (text: string) =>
      /h-\[?(\d+(?:px)?\]?)/.exec(screen.getByText(text).className)?.[0];
    expect(height("sm")).toBe(height("b-sm"));
    expect(height("sm")).toBe("h-[18px]");
    expect(height("md")).toBe("h-5");
  });
});

describe("StatusLine", () => {
  it("aria-live=polite 只包阶段文字，细节与计时不播报", () => {
    const { container } = render(
      <StatusLine
        tone="working"
        label="调用工具"
        detail="pnpm test"
        since={1_000}
        now={13_000}
        spinning
      />,
    );
    const live = container.querySelectorAll("[aria-live]");
    expect(live).toHaveLength(1);
    expect(live[0]!.getAttribute("aria-live")).toBe("polite");
    expect(live[0]!.textContent).toBe("调用工具");
    const line = container.querySelector("[data-slot='status-line']")!;
    expect(
      line.querySelector("[data-slot='status-line-detail']")?.textContent,
    ).toBe("pnpm test");
    expect(
      line.querySelector("[data-slot='status-line-since']"),
    ).not.toBeNull();
    expect(
      live[0]!.contains(line.querySelector("[data-slot='status-line-since']")),
    ).toBe(false);
  });

  it("spinning 前导是 Spinner 12，否则是 StatusDot 6", () => {
    const { container, rerender } = render(
      <StatusLine tone="working" label="运行" spinning />,
    );
    expect(container.querySelector("[data-slot='spinner']")).not.toBeNull();
    expect(container.querySelector("[data-slot='status-dot']")).toBeNull();
    rerender(<StatusLine tone="attention" label="需要你" />);
    expect(container.querySelector("[data-slot='spinner']")).toBeNull();
    expect(
      (container.querySelector("[data-slot='status-dot']") as HTMLElement)
        .dataset.size,
    ).toBe("6");
  });

  it("compact 只留阶段 + 计时；没有 since 不显示计时", () => {
    const { container, rerender } = render(
      <StatusLine
        tone="working"
        label="运行"
        detail="细节"
        since={0}
        now={5_000}
        compact
      />,
    );
    expect(
      container.querySelector("[data-slot='status-line-detail']"),
    ).toBeNull();
    expect(
      container.querySelector("[data-slot='status-line-since']"),
    ).not.toBeNull();
    rerender(<StatusLine tone="working" label="运行" detail="细节" />);
    expect(
      container.querySelector("[data-slot='status-line-since']"),
    ).toBeNull();
    expect(
      container.querySelector("[data-slot='status-line-detail']"),
    ).not.toBeNull();
  });
});

describe("TextSwap", () => {
  it("第一次渲染不播；换字时旧字 aria-hidden 留 120ms，新字带淡入", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<TextSwap>复制</TextSwap>);
    expect(container.querySelector("[data-slot='text-swap-old']")).toBeNull();
    expect(
      container.querySelector("[data-slot='text-swap-new']")!.className,
    ).not.toContain("anim-swap-in");

    rerender(<TextSwap>已复制</TextSwap>);
    const old = container.querySelector("[data-slot='text-swap-old']");
    expect(old?.textContent).toBe("复制");
    expect(old?.getAttribute("aria-hidden")).toBe("true");
    expect(
      container.querySelector("[data-slot='text-swap-new']")!.className,
    ).toContain("anim-swap-in");
    expect(screen.getByText("已复制")).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(130);
    });
    expect(container.querySelector("[data-slot='text-swap-old']")).toBeNull();
  });

  it("数字也行，读屏只读新字", () => {
    const { container } = render(<TextSwap>{100}</TextSwap>);
    expect(container.textContent).toBe("100");
  });
});
