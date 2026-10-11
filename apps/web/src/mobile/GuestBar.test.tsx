import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { usePreferencesStore } from "../app/preferences-store";
import { type GuestShare, resetHostedRelay } from "../sources/hosted";
import type { HostedRelay } from "../sources/hosted";
import { GuestBar, GuestFrame, INSTALL_URL } from "./GuestBar";

function relayWith(guest: GuestShare | null): HostedRelay {
  return { guest: () => guest } as unknown as HostedRelay;
}

beforeEach(() => usePreferencesStore.getState().setLocale("zh-CN"));
afterEach(() => {
  cleanup();
  resetHostedRelay(null);
});

describe("访客顶栏", () => {
  it("写主人、名字、权限、到期，右侧是「安装 Armadra」", () => {
    resetHostedRelay(
      relayWith({
        role: "viewer",
        name: "设计稿",
        ownerName: "小王",
        expiresAtMs: Date.UTC(2030, 0, 2, 12),
      }),
    );
    render(<GuestBar />);
    const bar = document.querySelector('[data-slot="guest-bar"]')!;
    expect(bar.textContent).toContain("小王 的 设计稿");
    expect(bar.textContent).toContain("查看");
    expect(bar.textContent).toContain("有效至");
    const install = screen.getByRole("link", { name: "安装 Armadra" });
    expect(install.getAttribute("href")).toBe(INSTALL_URL);
    expect(bar.textContent).not.toMatch(/源|挂载|中继|签发方|隧道/);
  });

  it("不知道主人时只写名字；非访客页面什么都不画，也不改布局", () => {
    resetHostedRelay(
      relayWith({ role: "", name: "studio", ownerName: "", expiresAtMs: 0 }),
    );
    const { container } = render(<GuestBar />);
    expect(container.textContent).toContain("studio");
    cleanup();

    resetHostedRelay(relayWith(null));
    const plain = render(
      <GuestFrame>
        <p>画布</p>
      </GuestFrame>,
    );
    expect(plain.container.innerHTML).toBe("<p>画布</p>");
    cleanup();

    resetHostedRelay(null);
    expect(render(<GuestBar />).container.innerHTML).toBe("");
  });
});
