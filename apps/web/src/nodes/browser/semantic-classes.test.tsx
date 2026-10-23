import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { usePreferencesStore } from "@/app/preferences-store";
import type { BrowserLease } from "@armadra/shared";

import { LeaseBadge } from "./Lease";
import { WebviewTabs } from "./WebviewTabs";
import { newTab, type TabsControl } from "./webview-tabs";

afterEach(() => cleanup());

describe("浏览器节点的语义写法", () => {
  it("接管按钮是 xs 档，不手写高度与字号", () => {
    usePreferencesStore.setState({ locale: "zh-CN" });
    const lease = {
      state: "agent",
      holder: { kind: "agent", id: "a1", displayName: "ama" },
    } as unknown as BrowserLease;
    render(
      <LeaseBadge
        lease={lease}
        deviceId="d1"
        busy={false}
        onTakeover={() => {}}
        onHandback={() => {}}
      />,
    );
    const button = screen.getByRole("button");
    expect(button.getAttribute("data-size")).toBe("xs");
    expect(button.className).not.toMatch(/h-\[22px\]|text-\[11px\]/);
  });

  it("标签条用 rounded-control / text-caption，不用任意值", () => {
    usePreferencesStore.setState({ locale: "zh-CN" });
    const first = newTab("https://a.test");
    const second = newTab("https://b.test");
    const control = {
      tabs: [first, second],
      activeId: first.id,
      active: first,
      select: vi.fn(),
      close: vi.fn(),
      open: vi.fn(),
    } as unknown as TabsControl;
    const { container } = render(<WebviewTabs control={control} />);
    const tab = container.querySelector('[data-slot="browser-tab"]')!;
    expect(tab.className).toContain("rounded-control");
    expect(tab.className).toContain("text-caption");
    expect(container.innerHTML).not.toMatch(/rounded-\[|text-\[/);
  });
});
