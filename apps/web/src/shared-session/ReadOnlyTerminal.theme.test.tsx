import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 会话查看页里的只读终端也跟着配色走（#501）：属性写在外层，切应用主题或终端
 * 偏好「配色」时只换 `options.theme`，不重建 xterm、不重连。
 */

const fixture = vi.hoisted(() => ({
  instances: [] as { options: { theme?: Record<string, string> } }[],
  disposed: 0,
}));

vi.mock("@/api/sockets", () => ({ terminalWebSocketUrl: () => "ws://x" }));
vi.mock("@/terminal/transport", () => ({
  createTerminalTransport: () => ({ resize: vi.fn(), close: vi.fn() }),
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: { theme?: Record<string, string> };
    unicode = { activeVersion: "" };
    constructor(options: { theme?: Record<string, string> } = {}) {
      this.options = { theme: options.theme };
      fixture.instances.push(this);
    }
    loadAddon() {}
    open() {}
    reset() {}
    write() {}
    dispose() {
      fixture.disposed += 1;
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));

import { installDomPolyfills } from "@/app/test-harness";
import { usePreferencesStore } from "@/app/preferences-store";
import { ReadOnlyTerminal } from "./ReadOnlyTerminal";

installDomPolyfills();

let style: HTMLStyleElement;
beforeAll(() => {
  style = document.createElement("style");
  style.textContent = readFileSync(
    resolve(import.meta.dirname, "../styles/tokens.css"),
    "utf8",
  );
  document.head.appendChild(style);
});
afterAll(() => style.remove());
beforeEach(() => {
  fixture.instances = [];
  fixture.disposed = 0;
  document.documentElement.removeAttribute("data-theme");
  usePreferencesStore.getState().setTerminalPreference("colorScheme", "follow");
});
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
});

const source = { id: "local" } as never;

describe("ReadOnlyTerminal 配色", () => {
  it("跟着应用主题与终端配色换调色板，实例不重建", async () => {
    const view = render(<ReadOnlyTerminal source={source} sessionId="s1" />);
    const wrapper = view.container.querySelector<HTMLElement>(
      "[data-slot=read-only-terminal]",
    )!;
    const terminal = fixture.instances[0]!;
    expect(terminal.options.theme?.background).toBe("#0a0a0a");
    expect(wrapper.hasAttribute("data-term-scheme")).toBe(false);

    act(() => document.documentElement.setAttribute("data-theme", "light"));
    await waitFor(() =>
      expect(terminal.options.theme?.background).toBe("#fafafa"),
    );

    act(() =>
      usePreferencesStore
        .getState()
        .setTerminalPreference("colorScheme", "dark"),
    );
    await waitFor(() =>
      expect(terminal.options.theme?.background).toBe("#0a0a0a"),
    );
    expect(wrapper.getAttribute("data-term-scheme")).toBe("dark");

    act(() =>
      usePreferencesStore
        .getState()
        .setTerminalPreference("colorScheme", "follow"),
    );
    await waitFor(() =>
      expect(terminal.options.theme?.background).toBe("#fafafa"),
    );
    expect(fixture.instances).toHaveLength(1);
    expect(fixture.disposed).toBe(0);
  });
});
