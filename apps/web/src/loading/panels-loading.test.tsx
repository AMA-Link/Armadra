import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";

import { installDomPolyfills } from "@/app/test-harness";
import { usePreferencesStore } from "@/app/preferences-store";
import { GIT_CODE_LINE, GIT_ROW, GitLoadable } from "@/panels/git/git-loading";
import { LogTable } from "@/panels/git/log/LogTable";
import {
  LOG_COMPACT_ROW_HEIGHT,
  LOG_ROW_HEIGHT,
} from "@/panels/git/log/LogTable";
import { ForgeListSkeleton } from "@/panels/github/ForgeHosted";
import { useResources } from "@/panels/resources/use-resources";
import { Spinner } from "@/ui/spinner";
import { SKELETON_DELAY_MS } from "./use-skeleton-phase";

installDomPolyfills();

beforeEach(() => {
  vi.useFakeTimers();
  usePreferencesStore.setState({ locale: "en" });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe("Spinner", () => {
  it("不写死读屏名字：没传 label 就是装饰图标", () => {
    const { container } = render(<Spinner />);
    const icon = container.querySelector("[data-slot=spinner]")!;
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(icon.getAttribute("aria-label")).toBeNull();
    expect(icon.getAttribute("role")).toBeNull();
  });

  it("调用方传了 label 才是 status；转圈是 anim-spin，减少动效下保留（motion.css）", () => {
    render(<Spinner aria-label="保存中" />);
    const icon = screen.getByRole("status", { name: "保存中" });
    expect(icon.getAttribute("class")).toContain("anim-spin");
    expect(icon.getAttribute("class")).not.toContain(
      "motion-reduce:animate-none",
    );
  });
});

describe("Git 面板加载态", () => {
  it("200 ms 内不可见占位，到点才显示，加载完立刻让位给内容", () => {
    const { container, rerender } = render(
      <GitLoadable loading size={3}>
        <p>内容</p>
      </GitLoadable>,
    );
    const holder = () => container.querySelector("[data-slot=loadable]")!;
    expect(holder().getAttribute("data-phase")).toBe("hold");
    expect(holder().className).toContain("invisible");
    tick(SKELETON_DELAY_MS);
    expect(holder().getAttribute("data-phase")).toBe("show");
    expect(holder().className).not.toContain("invisible");
    tick(400);
    rerender(
      <GitLoadable loading={false} size={3}>
        <p>内容</p>
      </GitLoadable>,
    );
    expect(screen.getByText("内容")).toBeTruthy();
  });

  it("短于 200 ms 的加载从不出骨架", () => {
    const { container, rerender } = render(<GitLoadable loading size={3} />);
    tick(100);
    rerender(
      <GitLoadable loading={false}>
        <p>内容</p>
      </GitLoadable>,
    );
    tick(1000);
    expect(container.querySelector("[data-slot=git-list-skeleton]")).toBeNull();
    expect(screen.getByText("内容")).toBeTruthy();
  });

  it("骨架行与代码行用同一档高度常量", () => {
    const { container } = render(
      <>
        <GitLoadable loading size={2} />
        <GitLoadable loading kind="code" size={2} />
      </>,
    );
    const rows = container.querySelectorAll("[data-slot=git-skeleton-row]");
    expect(rows).toHaveLength(2);
    rows.forEach((row) => expect(row.className).toContain(GIT_ROW));
    const code = container.querySelector("[data-slot=git-code-skeleton]")!;
    expect(code.innerHTML).toContain(GIT_CODE_LINE);
  });
});

describe("提交表格骨架", () => {
  const props = {
    commits: [],
    colors: new Map([[".", 0]]),
    selected: null,
    onSelect: () => undefined,
    uncommitted: [],
    showHash: true,
    myEmail: null,
    hasMore: false,
    loading: true,
    onLoadMore: () => undefined,
  } as const;

  it("首批提交没到：行高同真实行（常规 24、紧凑 20）", () => {
    const { container, rerender } = render(
      <LogTable {...props} compact={false} />,
    );
    tick(SKELETON_DELAY_MS);
    const row = () =>
      container.querySelector<HTMLElement>("[data-slot=git-log-skeleton-row]")!;
    expect(row().style.height).toBe(`${LOG_ROW_HEIGHT}px`);
    rerender(<LogTable {...props} compact />);
    expect(row().style.height).toBe(`${LOG_COMPACT_ROW_HEIGHT}px`);
  });

  it("续页时不换成骨架，底部那一行预留高度", () => {
    const commits = [
      {
        repositoryPath: ".",
        oid: "0".repeat(40),
        parents: [],
        subject: "c",
        authorName: "A",
        authorEmail: "a@example.invalid",
        authorTime: "2026-09-01T00:00:00Z",
        committerTime: "2026-09-01T00:00:00Z",
        refs: [],
      },
    ];
    const { container } = render(
      <LogTable {...props} commits={commits} hasMore compact={false} />,
    );
    tick(SKELETON_DELAY_MS * 2);
    expect(container.querySelector("[data-slot=git-log-skeleton]")).toBeNull();
    expect(container.querySelector("p[role=status]")!.className).toContain(
      "h-(--row-h)",
    );
  });
});

describe("代码托管列表骨架", () => {
  it("与真实行同样的圆角与边框，五行", () => {
    const { container } = render(<ForgeListSkeleton label="加载中" />);
    const rows = container.querySelectorAll(
      "[data-slot=forge-list-skeleton] > div",
    );
    expect(rows).toHaveLength(5);
    rows.forEach((row) => {
      expect(row.className).toContain("rounded-card");
      expect(row.className).toContain("border-border");
    });
  });
});

describe("资源采样", () => {
  it("打开即 loading：第一帧就不是空白", () => {
    const { result } = renderHook(() => useResources(null, false));
    expect(result.current.loading).toBe(false);
    const opened = renderHook(() => useResources("ws", true));
    expect(opened.result.current.loading).toBe(true);
    opened.unmount();
  });
});
