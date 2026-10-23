import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import {
  SKELETON_DELAY_MS,
  SKELETON_MIN_VISIBLE_MS,
} from "@/loading/use-skeleton-phase";
import { SettingsLoadable, ValueLoadable } from "./SettingsLoadable";
import { SettingsRow } from "./SettingsRow";
import { SkeletonSettingsRow } from "@/ui/skeletons";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

const row = () => (
  <SettingsRow label="开关">
    <button type="button">真控件</button>
  </SettingsRow>
);

describe("SettingsLoadable", () => {
  it("设置未到：先不可见占位，200 ms 后显示，到了换成真控件", () => {
    const { container, rerender } = render(
      <SettingsLoadable loading control="switch">
        {row()}
      </SettingsLoadable>,
    );
    const holder = () => container.querySelector("[data-slot=loadable]");
    expect(holder()?.getAttribute("data-phase")).toBe("hold");
    expect(holder()?.className).toContain("invisible");
    // 占位阶段不可见，也不进读屏树。
    expect(holder()?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByText("真控件")).toBeNull();

    tick(SKELETON_DELAY_MS);
    expect(holder()?.getAttribute("data-phase")).toBe("show");
    expect(holder()?.className).not.toContain("invisible");
    expect(holder()?.hasAttribute("aria-hidden")).toBe(false);

    tick(SKELETON_MIN_VISIBLE_MS);
    rerender(
      <SettingsLoadable loading={false} control="switch">
        {row()}
      </SettingsLoadable>,
    );
    expect(screen.getByText("真控件")).toBeTruthy();
    expect(holder()).toBeNull();
  });

  it("短于 200 ms 到达：从不出骨架", () => {
    const { container, rerender } = render(
      <SettingsLoadable loading control="select">
        {row()}
      </SettingsLoadable>,
    );
    tick(100);
    rerender(
      <SettingsLoadable loading={false} control="select">
        {row()}
      </SettingsLoadable>,
    );
    expect(screen.getByText("真控件")).toBeTruthy();
    tick(1000);
    expect(container.querySelector("[data-slot=skeleton-settings]")).toBeNull();
  });

  it("骨架行与真实设置行共用同一盒模型类（行高不跳）", () => {
    const real = render(row()).container.querySelector(".settings-row");
    cleanup();
    const fake = render(<SkeletonSettingsRow control="switch" />).container
      .firstElementChild as HTMLElement;
    for (const cls of ["px-4", "gap-4"]) {
      expect(real?.className, cls).toContain(cls);
      expect(fake.className, cls).toContain(cls);
    }
  });

  it("控件条高度取自真实控件：select 同 Select sm（h-7），input 同 Input（h-8）", () => {
    const bar = (control: "select" | "input" | "switch") => {
      const { container } = render(<SkeletonSettingsRow control={control} />);
      const node = container.querySelector(
        "[data-slot=skeleton-settings-row] > :last-child",
      ) as HTMLElement;
      cleanup();
      return node.className;
    };
    expect(bar("select")).toContain("h-7");
    expect(bar("input")).toContain("h-8");
    expect(bar("switch")).toContain("h-5");
  });

  it("grouped 的骨架带 SettingsGroup 卡片；行数与控件形状可选", () => {
    const { container } = render(
      <SettingsLoadable grouped loading rows={2} control="switch" title="组">
        <div />
      </SettingsLoadable>,
    );
    tick(SKELETON_DELAY_MS);
    expect(container.querySelector("section")).not.toBeNull();
    expect(screen.getByText("组")).toBeTruthy();
    expect(
      container.querySelectorAll("[data-slot=skeleton-settings-row]"),
    ).toHaveLength(2);
    expect(container.querySelectorAll(".rounded-full")).toHaveLength(2);
  });

  it("骨架条带 reduced-motion 类", () => {
    const { container } = render(
      <SettingsLoadable loading>
        <div />
      </SettingsLoadable>,
    );
    tick(SKELETON_DELAY_MS);
    for (const bar of container.querySelectorAll("[data-slot=skeleton]"))
      expect(bar.className).toContain("motion-reduce:animate-none");
  });
});

describe("ValueLoadable", () => {
  it("数值位：到点才出条，到了换成值", () => {
    const { container, rerender } = render(
      <ValueLoadable loading className="h-4 w-12">
        <span>42</span>
      </ValueLoadable>,
    );
    expect(container.querySelector("[data-slot=loadable]")).not.toBeNull();
    tick(SKELETON_DELAY_MS);
    const bar = container.querySelector("[data-slot=skeleton]");
    expect(bar?.className).toContain("h-4");
    tick(SKELETON_MIN_VISIBLE_MS);
    rerender(
      <ValueLoadable loading={false}>
        <span>42</span>
      </ValueLoadable>,
    );
    expect(screen.getByText("42")).toBeTruthy();
    expect(container.querySelector("[data-slot=skeleton]")).toBeNull();
  });
});
