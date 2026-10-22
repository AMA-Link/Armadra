import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import { AppSkeleton } from "@/app/AppSkeleton";
import { OverlaySuspense } from "@/app/OverlayFallback";
import { CanvasSkeleton } from "@/canvas/CanvasSkeleton";
import { NodeBodyFallback } from "@/nodes/NodeBodyFallback";
import {
  AutomationSkeleton,
  CodeLinesSkeleton,
  DiffSkeleton,
  FILES_ROW,
  FilesSkeleton,
} from "@/nodes/NodeSkeletons";
import { PendingRows } from "@/sidebar/PendingRows";
import { TerminalStartSkeleton } from "@/terminal/TerminalStartSkeleton";
import { SKELETON_ROW } from "@/ui/skeletons";
import { DeferredSkeleton } from "./DeferredSkeleton";
import {
  SKELETON_DELAY_MS,
  SKELETON_MIN_VISIBLE_MS,
} from "./use-skeleton-phase";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const q = (selector: string) => document.querySelector(selector);

describe("DeferredSkeleton", () => {
  it("200 ms 内以不可见方式占位，到点才显示", () => {
    render(
      <DeferredSkeleton>
        <span>x</span>
      </DeferredSkeleton>,
    );
    const host = q("[data-slot=deferred-skeleton]") as HTMLElement;
    expect(host.dataset.phase).toBe("hold");
    expect(host.className).toContain("invisible");
    tick(SKELETON_DELAY_MS);
    expect(host.dataset.phase).toBe("show");
    expect(host.className).not.toContain("invisible");
  });

  it("hidden：延迟内不占位（浮层这类外形不定的）", () => {
    render(
      <DeferredSkeleton hidden>
        <span>x</span>
      </DeferredSkeleton>,
    );
    expect(q("[data-slot=deferred-skeleton]")).toBeNull();
    tick(SKELETON_DELAY_MS);
    expect(q("[data-slot=deferred-skeleton]")).toBeTruthy();
  });
});

describe("画布与整页骨架", () => {
  it("画布骨架：点阵底加节点形占位；chrome 时才画工具簇与 Dock 的位置", () => {
    const { rerender } = render(<CanvasSkeleton />);
    expect(q("[data-slot=canvas-skeleton]")?.getAttribute("aria-busy")).toBe(
      "true",
    );
    expect(
      document.querySelectorAll("[data-slot=canvas-skeleton-node]").length,
    ).toBeGreaterThanOrEqual(3);
    const without = document.querySelectorAll("[data-slot=skeleton]").length;
    rerender(<CanvasSkeleton chrome />);
    expect(document.querySelectorAll("[data-slot=skeleton]").length).toBe(
      without + 2,
    );
  });

  it("整页骨架：hidden 时占位但不可见", () => {
    const { rerender } = render(<AppSkeleton hidden />);
    expect((q("[data-slot=app-skeleton]") as HTMLElement).className).toContain(
      "invisible",
    );
    rerender(<AppSkeleton />);
    expect(
      (q("[data-slot=app-skeleton]") as HTMLElement).className,
    ).not.toContain("invisible");
    expect(q("[data-slot=canvas-skeleton]")).toBeTruthy();
  });

  it("骨架条带 motion-reduce:animate-none", () => {
    render(<CanvasSkeleton chrome />);
    for (const bar of document.querySelectorAll("[data-slot=skeleton]"))
      expect(bar.className).toContain("motion-reduce:animate-none");
  });
});

describe("分块占位", () => {
  const Suspended = (): never => {
    throw new Promise(() => undefined);
  };

  it("浮层分块挂起：200 ms 内什么都不画，之后按外形画壳", () => {
    render(
      <OverlaySuspense shape="drawer">
        <Suspended />
      </OverlaySuspense>,
    );
    expect(q("[data-slot=overlay-skeleton]")).toBeNull();
    tick(SKELETON_DELAY_MS);
    expect(q("[data-slot=overlay-skeleton]")?.getAttribute("data-shape")).toBe(
      "drawer",
    );
  });

  it("节点体占位：按类型给行数，延迟内不可见", () => {
    render(<NodeBodyFallback type="editor" />);
    expect(q("[data-slot=deferred-skeleton]")?.className).toContain(
      "invisible",
    );
    expect(
      document.querySelectorAll(
        "[data-slot=skeleton-node-body] [data-slot=skeleton]",
      ),
    ).toHaveLength(6);
    tick(SKELETON_DELAY_MS);
    expect(q("[data-slot=deferred-skeleton]")?.className).not.toContain(
      "invisible",
    );
  });
});

describe("侧栏树的占位行", () => {
  it("行高取 compact 档（与工作空间行 / 画布行同一份），缩进随 indent", () => {
    const { rerender } = render(<PendingRows loading rows={2} />);
    const rows = document.querySelectorAll("[data-slot=skeleton-row]");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.className).toContain(SKELETON_ROW.compact);
      expect(row.className).toContain("pl-1.5");
    }
    rerender(<PendingRows loading rows={2} indent />);
    expect(q("[data-slot=skeleton-row]")?.className).toContain("pl-4");
  });

  it("先不可见占位，显示后至少停 300 ms；有缓存（loading 为假）时不出现", () => {
    const { rerender } = render(<PendingRows loading rows={2} />);
    const host = q("[data-slot=tree-pending]") as HTMLElement;
    expect(host.className).toContain("invisible");
    tick(SKELETON_DELAY_MS);
    expect(host.className).not.toContain("invisible");
    tick(50);
    rerender(<PendingRows loading={false} rows={2} />);
    expect(q("[data-slot=tree-pending]")).toBeTruthy();
    tick(SKELETON_MIN_VISIBLE_MS);
    expect(q("[data-slot=tree-pending]")).toBeNull();

    cleanup();
    render(<PendingRows loading={false} rows={2} />);
    expect(q("[data-slot=tree-pending]")).toBeNull();
  });
});

describe("节点体骨架", () => {
  it("文件节点：骨架行与真实行共用 FILES_ROW", () => {
    render(<FilesSkeleton rows={4} />);
    const rows = document.querySelectorAll("[data-slot=skeleton-row]");
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.className).toContain(FILES_ROW);
  });

  it("差异节点：文件头取 compact 行高", () => {
    render(<DiffSkeleton files={3} />);
    const heads = document.querySelectorAll(`.${SKELETON_ROW.compact}`);
    expect(heads.length).toBeGreaterThanOrEqual(3);
  });

  it("编辑器：行号列加代码条，读屏有名字，不再用 CSS animation-delay", () => {
    render(<CodeLinesSkeleton lines={5} />);
    const host = q("[data-slot=editor-loading]") as HTMLElement;
    expect(host.getAttribute("role")).toBe("status");
    expect(host.getAttribute("aria-label")).toBeTruthy();
    expect(host.getAttribute("style")).toBeNull();
    expect(host.querySelectorAll("[data-slot=skeleton]")).toHaveLength(10);
  });

  it("自动化卡：徽标条加三行 dt/dd", () => {
    render(<AutomationSkeleton />);
    expect(document.querySelectorAll("[data-slot=skeleton]")).toHaveLength(7);
  });
});

describe("终端首帧", () => {
  it("连接建立期间的行条：延迟内不渲染，之后不挡指针", () => {
    render(<TerminalStartSkeleton />);
    const host = q("[data-slot=terminal-start-skeleton]") as HTMLElement;
    expect(host.className).toContain("pointer-events-none");
    expect(q("[data-slot=skeleton]")).toBeNull();
    tick(SKELETON_DELAY_MS);
    expect(q("[data-slot=skeleton]")).toBeTruthy();
  });
});
