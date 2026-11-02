import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { installDomPolyfills, TestProviders } from "@/app/test-harness";
import { Badge } from "@/ui/badge";
import {
  HeaderChips,
  MAX_VISIBLE_CHIPS,
  overflowCount,
  visibleChipsFor,
} from "./HeaderChips";

beforeAll(installDomPolyfills);
afterEach(cleanup);

function chips(count: number) {
  return Array.from({ length: count }, (_, index) => (
    <Badge key={index} variant="outline" size="sm">
      {`chip ${index}`}
    </Badge>
  ));
}

describe("HeaderChips", () => {
  it("counts only what overflows", () => {
    expect(MAX_VISIBLE_CHIPS).toBe(3);
    expect(overflowCount(3)).toBe(0);
    expect(overflowCount(5)).toBe(2);
  });

  it("shows up to three chips and folds the rest into one counter", async () => {
    const { container, rerender } = render(
      <TestProviders>
        <HeaderChips>{chips(3)}</HeaderChips>
      </TestProviders>,
    );
    await waitFor(() =>
      expect(
        container.querySelector('[data-slot="header-chips"]')?.children,
      ).toHaveLength(3),
    );
    expect(
      container.querySelector('[data-slot="header-chips-overflow"]'),
    ).toBeNull();

    rerender(
      <TestProviders>
        <HeaderChips>{chips(4)}</HeaderChips>
      </TestProviders>,
    );
    const overflow = await waitFor(() => {
      const element = container.querySelector(
        '[data-slot="header-chips-overflow"]',
      ) as HTMLElement | null;
      expect(element).toBeTruthy();
      return element as HTMLElement;
    });
    // 胶囊统一是 `Badge outline size=sm`（18 / caption / 等宽数字），折叠计数也是
    expect(overflow.dataset.variant).toBe("outline");
    expect(overflow.dataset.size).toBe("sm");
    expect(overflow.className).toContain("h-[18px]");
    expect(overflow.className).toContain("tabular-nums");
    expect(screen.getByText("chip 0").dataset.size).toBe("sm");
  });

  it("窄节点少平铺几枚，多出来的折进计数", async () => {
    expect(visibleChipsFor(undefined)).toBe(3);
    expect(visibleChipsFor(640)).toBe(3);
    expect(visibleChipsFor(560)).toBe(2);
    expect(visibleChipsFor(480)).toBe(1);

    const { container } = render(
      <TestProviders>
        <HeaderChips max={visibleChipsFor(480)}>{chips(3)}</HeaderChips>
      </TestProviders>,
    );
    const overflow = await waitFor(() => {
      const element = container.querySelector(
        '[data-slot="header-chips-overflow"]',
      ) as HTMLElement | null;
      expect(element).toBeTruthy();
      return element as HTMLElement;
    });
    expect(overflow.textContent).toBe("···2");
    const host = container.querySelector('[data-slot="header-chips"]')!;
    expect(host.getAttribute("data-max")).toBe("1");
    expect(host.className).toContain("data-max='1'");
  });
});
