import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Progress } from "@/ui/progress";

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
