import { scoped } from "../sources/scope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import type { Workspace } from "@armadra/shared";

vi.mock("../api/client", () => ({
  runtimeApi: {
    listWorkspaces: vi.fn().mockResolvedValue([]),
    listBoards: vi.fn().mockResolvedValue([]),
    loadBoard: vi.fn(),
    openWorkspace: vi.fn().mockResolvedValue(undefined),
    sessions: vi.fn().mockResolvedValue([]),
    deliveries: vi.fn().mockResolvedValue([]),
    agents: vi.fn().mockResolvedValue([]),
    usage: vi.fn().mockResolvedValue(null),
    conversations: vi.fn().mockResolvedValue([]),
    // The SSH prompt dialog polls on mount now that the overlays gate mounts
    // it eagerly (it is the one overlay that has to be awake before a prompt).
    sshPrompts: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../platform", () => ({
  isDesktop: () => false,
  pickDirectory: vi.fn().mockResolvedValue(null),
  onFileDrop: () => () => undefined,
}));

vi.mock("../api/events", () => ({
  useWorkspaceEvents: () => undefined,
  onWorkspaceEvent: () => () => undefined,
  onWorkspaceConnection: () => () => undefined,
  onWorkspaceAccessLost: () => () => undefined,
  useRuntimeConnection: () => "open",
}));

const identity = vi.hoisted(() => ({
  listeners: new Set<(change: string) => void>(),
}));
vi.mock("../api/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/identity")>();
  return {
    ...actual,
    onIdentitySessionChange: (listener: (change: string) => void) => {
      identity.listeners.add(listener);
      return () => identity.listeners.delete(listener);
    },
  };
});

/** 画布本身在 jsdom 里跑不动，这里只关心它在不在。 */
vi.mock("../canvas/FlowWorkspace", () => ({
  FlowWorkspace: () => <div data-testid="canvas" />,
}));

import { installDomPolyfills } from "./test-harness";
import { runtimeApi } from "../api/client";
import { usePreferencesStore } from "./preferences-store";
import { useCanvasStore } from "../store/canvas-store";
import { App } from "./App";
import { resetSplashPhase, setSplashPhase } from "../splash/session";
import {
  FIRST_SCREEN_LEAD_MS,
  FIRST_SCREEN_TOTAL_MS,
} from "./use-first-screen-enter";

installDomPolyfills();

const timestamp = "2026-09-05T10:00:00.000Z";
const workspace: Workspace = {
  id: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "repo",
  rootPath: "/repo",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  executionHostId: "",
  lastOpenedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetSplashPhase();
});

beforeEach(() => {
  vi.mocked(runtimeApi.listWorkspaces).mockResolvedValue([]);
  useCanvasStore.setState({ workspace: null, boards: [], boardId: null });
  useCanvasStore.getState().setPanel("sidebar", "open");
  usePreferencesStore.setState({
    openWorkspaceKeys: [],
    collapsedWorkspaceKeys: [],
    pinnedBoardKeys: [],
  });
});

describe("App", () => {
  it("没有工作空间也直接进壳：侧栏在，画布区空着，没有首页", () => {
    render(<App />);

    expect(screen.getByLabelText("侧栏")).toBeTruthy();
    expect(screen.getByText("Armadra")).toBeTruthy();
    // 首页删掉之后这些都不该再出现
    expect(screen.queryByText("最近")).toBeNull();
    expect(screen.queryByText("还没有工作空间")).toBeNull();
    expect(screen.queryByTestId("canvas")).toBeNull();
  });

  it("首次启动什么都不记得时，进列表里最近打开的工作空间", async () => {
    vi.mocked(runtimeApi.listWorkspaces).mockResolvedValue([
      { ...workspace, boards: [] },
    ]);
    render(<App />);

    expect(await screen.findByTestId("canvas")).toBeTruthy();
    expect(useCanvasStore.getState().workspace?.id).toBe(workspace.id);
    expect(usePreferencesStore.getState().openWorkspaceKeys).toEqual([
      scoped(workspace.id),
    ]);
  });

  it("关掉「恢复上次工作空间」后不替用户打开任何项目", async () => {
    vi.mocked(runtimeApi.listWorkspaces).mockResolvedValue([
      { ...workspace, boards: [] },
    ]);
    usePreferencesStore.setState({ restoreLastWorkspace: false });
    render(<App />);

    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(screen.queryByTestId("canvas")).toBeNull();
    usePreferencesStore.setState({ restoreLastWorkspace: true });
  });

  it("打开工作空间后画布出现，壳不重建", () => {
    render(<App />);
    expect(screen.queryByTestId("canvas")).toBeNull();

    act(() => useCanvasStore.getState().setWorkspace(workspace));

    expect(screen.getByTestId("canvas")).toBeTruthy();
    expect(screen.getByLabelText("侧栏")).toBeTruthy();
  });
});

/**
 * ui-acp-refresh §7.3 E-2：CSRF 轮换、令牌续期、会话消失都不让整页重取；会话
 * 出现或换人时全量重取。
 */
describe("identity changes", () => {
  it("re-reads only what the change calls for", async () => {
    const invalidate = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    render(<App />);
    await act(async () => {});
    invalidate.mockClear();
    const fire = (change: string) =>
      act(() => {
        for (const listener of identity.listeners) listener(change);
      });

    fire("rotated");
    fire("gone");
    expect(invalidate).not.toHaveBeenCalled();

    fire("appeared");
    expect(invalidate).toHaveBeenCalledTimes(1);

    fire("switched");
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenLastCalledWith();
    invalidate.mockRestore();
  });
});

/**
 * 首屏错落入场（设计系统 §8.7）：只在开屏刚退场的那一次播。平时的首帧什么都不
 * 带；开屏放着时三块先藏好（`wait`），退场 80ms 后依次入场（`play`），播完摘掉。
 */
describe("App 首屏错落入场", () => {
  const shell = () =>
    document.querySelector<HTMLElement>(".app-shell") as HTMLElement;

  it("平时的首帧不带 data-enter，也不播", () => {
    render(<App />);
    expect(shell().dataset.enter).toBeUndefined();
  });

  it("开屏放着时先藏好，退场后 80ms 起播，播完摘掉", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    setSplashPhase("playing");
    render(<App />);
    expect(shell().dataset.enter).toBe("wait");

    act(() => setSplashPhase("leaving"));
    expect(shell().dataset.enter).toBe("wait");
    act(() => void vi.advanceTimersByTime(FIRST_SCREEN_LEAD_MS - 1));
    expect(shell().dataset.enter).toBe("wait");
    act(() => void vi.advanceTimersByTime(1));
    expect(shell().dataset.enter).toBe("play");

    act(() => setSplashPhase("done"));
    expect(shell().dataset.enter).toBe("play");
    act(() => void vi.advanceTimersByTime(FIRST_SCREEN_TOTAL_MS));
    expect(shell().dataset.enter).toBeUndefined();
  });

  it("开屏已经退场之后才挂载的 App 不补播", () => {
    setSplashPhase("done");
    render(<App />);
    expect(shell().dataset.enter).toBeUndefined();
  });

  it("减少动效下不错落：开屏放着也不藏", () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
      onchange: null,
    })) as typeof window.matchMedia;
    try {
      setSplashPhase("playing");
      render(<App />);
      expect(shell().dataset.enter).toBeUndefined();
    } finally {
      window.matchMedia = original;
    }
  });
});
