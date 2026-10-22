import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";

import { SkeletonList } from "@/ui/skeletons";
import { Loadable } from "./Loadable";
import {
  SKELETON_DELAY_MS,
  SKELETON_MIN_VISIBLE_MS,
  useSkeletonPhase,
} from "./use-skeleton-phase";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe("useSkeletonPhase", () => {
  it("不在等就是 idle：有缓存时不出骨架", () => {
    const { result } = renderHook(() => useSkeletonPhase(false));
    expect(result.current).toBe("idle");
  });

  it("200 ms 之内先占位（hold），到点才显示（show）", () => {
    const { result } = renderHook(() => useSkeletonPhase(true));
    expect(result.current).toBe("hold");
    tick(SKELETON_DELAY_MS - 1);
    expect(result.current).toBe("hold");
    tick(1);
    expect(result.current).toBe("show");
  });

  it("短于 200 ms 的加载从不显示骨架", () => {
    const { result, rerender } = renderHook(({ on }) => useSkeletonPhase(on), {
      initialProps: { on: true },
    });
    tick(120);
    rerender({ on: false });
    expect(result.current).toBe("idle");
    tick(1000);
    expect(result.current).toBe("idle");
  });

  it("显示后至少停满 300 ms 再让位", () => {
    const { result, rerender } = renderHook(({ on }) => useSkeletonPhase(on), {
      initialProps: { on: true },
    });
    tick(SKELETON_DELAY_MS);
    expect(result.current).toBe("show");
    tick(100);
    rerender({ on: false });
    expect(result.current).toBe("show");
    tick(SKELETON_MIN_VISIBLE_MS - 100 - 1);
    expect(result.current).toBe("show");
    tick(1);
    expect(result.current).toBe("idle");
  });
});

describe("Loadable", () => {
  const skeleton = <SkeletonList rows={2} />;

  it("占位阶段骨架已在树里但不可见；到点后可见；数据到了换成内容", () => {
    const { rerender, container } = render(
      <Loadable loading skeleton={skeleton}>
        <p>内容</p>
      </Loadable>,
    );
    const holder = container.querySelector("[data-slot=loadable]");
    expect(holder?.getAttribute("data-phase")).toBe("hold");
    expect(holder?.className).toContain("invisible");
    expect(container.querySelectorAll("[data-slot=skeleton-row]")).toHaveLength(
      2,
    );
    expect(screen.queryByText("内容")).toBeNull();

    tick(SKELETON_DELAY_MS);
    expect(
      container
        .querySelector("[data-slot=loadable]")
        ?.getAttribute("data-phase"),
    ).toBe("show");
    expect(
      container.querySelector("[data-slot=loadable]")?.className,
    ).not.toContain("invisible");

    tick(SKELETON_MIN_VISIBLE_MS);
    rerender(
      <Loadable loading={false} skeleton={skeleton}>
        <p>内容</p>
      </Loadable>,
    );
    expect(screen.getByText("内容")).toBeTruthy();
    expect(container.querySelector("[data-slot=loadable]")).toBeNull();
  });

  it("有缓存（loading 为假）直接显示内容", () => {
    const { container } = render(
      <Loadable loading={false} skeleton={skeleton}>
        <p>缓存内容</p>
      </Loadable>,
    );
    expect(screen.getByText("缓存内容")).toBeTruthy();
    expect(container.querySelector("[data-slot=skeleton-list]")).toBeNull();
  });

  it("出错给带重试的行内错误，空给一句空态", () => {
    const retry = vi.fn();
    const { rerender, container } = render(
      <Loadable
        loading={false}
        skeleton={skeleton}
        error={new Error("x")}
        onRetry={retry}
      >
        <p>内容</p>
      </Loadable>,
    );
    expect(container.querySelector("[data-state-kind=error]")).toBeTruthy();
    expect(screen.queryByText("内容")).toBeNull();
    rerender(
      <Loadable loading={false} skeleton={skeleton} empty emptyTitle="没有项目">
        <p>内容</p>
      </Loadable>,
    );
    expect(container.querySelector("[data-state-kind=empty]")).toBeTruthy();
    expect(screen.getByText("没有项目")).toBeTruthy();
  });
});
