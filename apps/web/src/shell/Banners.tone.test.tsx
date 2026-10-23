import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Info } from "lucide-react";

vi.mock("../api/client", () => ({
  runtimeApi: {
    health: () => Promise.resolve({ ok: true }),
    terminalBackend: () => Promise.resolve({ kind: "direct" }),
    agentIntegration: () => Promise.resolve({ legacy: { found: [] } }),
    agents: () => Promise.resolve([]),
  },
}));

const { installDomPolyfills, TestProviders } = await import(
  "../app/test-harness"
);
const { Banner } = await import("./Banners");

installDomPolyfills();
afterEach(cleanup);

/** 语气 → 前导状态点的状态色与文字色类。 */
const TONES = [
  ["danger", "failed", "text-danger-text"],
  ["warn", "attention", "text-warn-text"],
  ["success", "done", "text-success-text"],
  ["info", "unread", "text-brand-text"],
] as const;

describe("横幅四档语气", () => {
  it.each(TONES)(
    "%s：前置 6px 状态点（%s），文字色跟语气",
    (tone, dotTone, textClass) => {
      render(
        <TestProviders>
          <Banner tone={tone} icon={<Info />} text="一条消息" />
        </TestProviders>,
      );
      const banner = screen.getByRole("status");
      expect(banner.getAttribute("data-tone")).toBe(tone);
      const dot = banner.querySelector("[data-slot='status-dot']");
      expect(dot?.getAttribute("data-tone")).toBe(dotTone);
      expect(dot?.getAttribute("data-size")).toBe("6");
      // 状态点是横幅的第一个子元素
      expect(banner.firstElementChild).toBe(dot);
      expect(banner.className).toContain(`data-[tone=${tone}]:${textClass}`);
    },
  );

  it("外观：36 高、card 圆角、1px 强边、浮层阴影，没有旧的药丸阴影", () => {
    render(
      <TestProviders>
        <Banner tone="info" icon={<Info />} text="一条消息" />
      </TestProviders>,
    );
    const classes = screen.getByRole("status").classList;
    for (const name of [
      "h-[36px]",
      "rounded-card",
      "border-border-strong",
      "shadow-overlay",
    ])
      expect(classes.contains(name)).toBe(true);
    expect(screen.getByRole("status").className).not.toContain("shadow-pill");
  });

  it("带动作与关闭钮时都能点", () => {
    const action = vi.fn();
    const dismiss = vi.fn();
    render(
      <TestProviders>
        <Banner
          tone="success"
          icon={<Info />}
          text="已完成"
          actionLabel="查看"
          onAction={action}
          onDismiss={dismiss}
        />
      </TestProviders>,
    );
    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    fireEvent.click(screen.getByRole("button", { name: "忽略" }));
    expect(action).toHaveBeenCalledTimes(1);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });
});
