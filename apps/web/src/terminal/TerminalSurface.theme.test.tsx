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
import type { TerminalNodeData } from "@armadra/shared";
import type { TerminalTransportHandlers } from "./transport";
import { installDomPolyfills } from "../app/test-harness";

/**
 * 终端配色即时换色（#501）：切应用主题、改终端偏好「配色」时，已打开的 xterm
 * 立即更新 `options.theme`，实例不重建、会话不重连。
 *
 * 注入真正的 `tokens.css`，让 jsdom 按层叠算 `--term-*`；xterm 本身用桩。
 */

const fixture = vi.hoisted(() => ({
  data: { kind: "terminal", sessionId: "session" } as TerminalNodeData,
  handlers: null as TerminalTransportHandlers | null,
  writes: [] as string[],
  urls: [] as string[],
  close: vi.fn(),
  /** 每条传输收到的输入与 resize，按创建顺序。 */
  inputs: [] as string[][],
  resizes: [] as [number, number][],
  /** 每个 `new Terminal` 的构造参数；`disposed` 记销毁次数。 */
  terminals: [] as { cols?: number; rows?: number }[],
  instances: [] as { options: { theme?: Record<string, string> } }[],
  disposed: 0,
  proposed: { cols: 80, rows: 24 } as
    | { cols: number; rows: number }
    | undefined,
  /** 画布缩放（缩小限帧用）。 */
  zoom: 1,
  getTerminal: vi.fn(),
  createTerminal: vi.fn(),
  wakeTerminal: vi.fn(),
}));

vi.mock("@/store/canvas-store", () => ({
  useCanvasStore: {
    subscribe: () => () => undefined,
    getState: () => ({
      workspace: { id: "workspace", rootPath: "/repo" },
      document: {
        board: { id: "board", viewport: { x: 0, y: 0, zoom: fixture.zoom } },
        nodes: [{ id: "node", data: fixture.data }],
      },
      updateNodeData: vi.fn(),
      updateNode: vi.fn(),
    }),
  },
}));
vi.mock("@/api/client", () => ({
  terminalWebSocketUrl: (sessionId: string) => `ws://runtime/${sessionId}`,
  runtimeApi: {
    getTerminal: (...args: unknown[]) => fixture.getTerminal(...args),
    createTerminal: (...args: unknown[]) => fixture.createTerminal(...args),
    wakeTerminal: (...args: unknown[]) => fixture.wakeTerminal(...args),
    agents: vi.fn(async () => []),
  },
}));
vi.mock("@/agent/status-store", () => ({
  useAgentStatusStore: {
    getState: () => ({ statuses: {}, markRead: vi.fn() }),
  },
}));
vi.mock("@/agent/pending-launch", () => ({
  armPendingLaunch: vi.fn(),
  usePendingLaunchWatcher: vi.fn(),
  usePendingLaunchStore: { getState: () => ({ entries: {} }) },
  disarmPendingLaunch: vi.fn(),
}));
vi.mock("./platform", () => ({
  runtimePlatform: () => "unix",
  loadRuntimePlatform: async () => "unix",
}));
vi.mock("./transport", () => ({
  createTerminalTransport: (
    url: string,
    handlers: TerminalTransportHandlers,
  ) => {
    fixture.urls.push(url);
    fixture.handlers = handlers;
    const inputs: string[] = [];
    fixture.inputs.push(inputs);
    return {
      state: "live",
      generation: 3,
      input: (data: string) => inputs.push(data),
      resize: (cols: number, rows: number) =>
        fixture.resizes.push([cols, rows]),
      close: fixture.close,
      terminate: vi.fn(),
    };
  },
}));
vi.mock("@/ui/toast", () => ({ toast: { error: vi.fn(), info: vi.fn() } }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    constructor(options: { cols?: number; rows?: number } = {}) {
      fixture.terminals.push({ cols: options.cols, rows: options.rows });
      fixture.instances.push(this);
      if (options.cols) this.cols = options.cols;
      if (options.rows) this.rows = options.rows;
    }
    unicode = { activeVersion: "" };
    parser = {
      registerOscHandler: () => ({ dispose() {} }),
      registerCsiHandler: () => ({ dispose() {} }),
      registerEscHandler: () => ({ dispose() {} }),
    };
    textarea = undefined;
    loadAddon(addon: { activate?: (terminal: unknown) => void }) {
      addon.activate?.(this);
    }
    open() {}
    reset() {}
    write(chunk: string, done?: () => void) {
      fixture.writes.push(chunk);
      done?.();
    }
    dispose() {
      fixture.disposed += 1;
    }
    focus() {}
    attachCustomKeyEventHandler() {}
    onData() {
      return { dispose() {} };
    }
    onSelectionChange() {
      return { dispose() {} };
    }
    onBell() {
      return { dispose() {} };
    }
    onTitleChange() {
      return { dispose() {} };
    }
    hasSelection() {
      return false;
    }
    paste() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    terminal: { cols: number; rows: number } | null = null;
    activate(terminal: { cols: number; rows: number }) {
      this.terminal = terminal;
    }
    proposeDimensions() {
      return fixture.proposed;
    }
    fit() {
      if (this.terminal && fixture.proposed) {
        this.terminal.cols = fixture.proposed.cols;
        this.terminal.rows = fixture.proposed.rows;
      }
    }
  },
}));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-clipboard", () => ({ ClipboardAddon: class {} }));

import { resetRenderBudget } from "./render-budget";
import { usePreferencesStore } from "@/app/preferences-store";
import { TerminalSurface } from "./TerminalSurface";

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
  vi.clearAllMocks();
  resetRenderBudget();
  fixture.data = { kind: "terminal", sessionId: "session" };
  fixture.handlers = null;
  fixture.writes = [];
  fixture.urls = [];
  fixture.inputs = [];
  fixture.resizes = [];
  fixture.terminals = [];
  fixture.instances = [];
  fixture.disposed = 0;
  fixture.proposed = { cols: 80, rows: 24 };
  fixture.zoom = 1;
  document.documentElement.removeAttribute("data-theme");
  usePreferencesStore.getState().setTerminalPreference("colorScheme", "follow");
  fixture.getTerminal.mockImplementation(async () => ({
    id: "session",
    workspaceId: "workspace",
    shell: "/bin/sh",
    generation: 3,
    status: "running",
    command: null,
    agentId: null,
  }));
});
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
});

const DARK_BG = "#0a0a0a";
const LIGHT_BG = "#fafafa";

async function mountSurface() {
  const view = render(
    <TerminalSurface nodeId="node" data={fixture.data} collapsed={false} />,
  );
  await waitFor(() => expect(fixture.instances).toHaveLength(1));
  const body = view.container.querySelector<HTMLElement>(
    "[data-slot=terminal-body]",
  )!;
  return { body, terminal: fixture.instances[0]! };
}

describe("终端配色即时换色", () => {
  it("挂载时按当前主题取调色板；跟随主题时终端体不带 data-term-scheme", async () => {
    const { body, terminal } = await mountSurface();
    expect(terminal.options.theme?.background).toBe(DARK_BG);
    expect(body.hasAttribute("data-term-scheme")).toBe(false);
  });

  it("切应用主题：options.theme 立即换成浅色，不重建实例", async () => {
    const { terminal } = await mountSurface();
    act(() => document.documentElement.setAttribute("data-theme", "light"));
    await waitFor(() =>
      expect(terminal.options.theme?.background).toBe(LIGHT_BG),
    );
    expect(terminal.options.theme?.foreground).toBe("#1f1f1f");
    act(() => document.documentElement.setAttribute("data-theme", "dark"));
    await waitFor(() =>
      expect(terminal.options.theme?.background).toBe(DARK_BG),
    );
    expect(fixture.instances).toHaveLength(1);
    expect(fixture.disposed).toBe(0);
  });

  it("浅色主题下改成「始终深色」：立即回深色，终端体带属性；改回跟随又变浅", async () => {
    document.documentElement.setAttribute("data-theme", "light");
    const { body, terminal } = await mountSurface();
    expect(terminal.options.theme?.background).toBe(LIGHT_BG);

    act(() =>
      usePreferencesStore
        .getState()
        .setTerminalPreference("colorScheme", "dark"),
    );
    await waitFor(() =>
      expect(terminal.options.theme?.background).toBe(DARK_BG),
    );
    expect(body.getAttribute("data-term-scheme")).toBe("dark");
    expect(terminal.options.theme?.red).toBe("#ff453a");

    // 始终深色时再切应用主题：仍是深色
    act(() => document.documentElement.setAttribute("data-theme", "dark"));
    act(() => document.documentElement.setAttribute("data-theme", "light"));
    await Promise.resolve();
    expect(terminal.options.theme?.background).toBe(DARK_BG);

    act(() =>
      usePreferencesStore
        .getState()
        .setTerminalPreference("colorScheme", "follow"),
    );
    await waitFor(() =>
      expect(terminal.options.theme?.background).toBe(LIGHT_BG),
    );
    expect(body.hasAttribute("data-term-scheme")).toBe(false);

    // 全程同一个实例：没有重建，没有重新建会话
    expect(fixture.instances).toHaveLength(1);
    expect(fixture.disposed).toBe(0);
    expect(fixture.createTerminal).not.toHaveBeenCalled();
  });
});
