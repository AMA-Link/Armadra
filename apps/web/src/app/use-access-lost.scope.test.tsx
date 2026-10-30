import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { WorkspaceSummary } from "@armadra/shared";

const info = vi.fn();
vi.mock("@/ui/toast", () => ({
  toast: {
    info: (...args: unknown[]) => info(...args),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

/** 这台主机此刻答的工作空间列表（授予收窄之后只剩范围内的）。 */
const listWorkspaces = vi.fn();
const openWorkspace = vi.fn();
const sessions = vi.fn();
vi.mock("../sources/source-api", () => ({
  sourceApi: () => ({ sessions: (...args: unknown[]) => sessions(...args) }),
}));
vi.mock("../api/client", async (original) => ({
  ...(await original<typeof import("../api/client")>()),
  runtimeApi: {
    listWorkspaces: (...args: unknown[]) => listWorkspaces(...args),
    openWorkspace: (...args: unknown[]) => openWorkspace(...args),
    sessions: (...args: unknown[]) => sessions(...args),
    deliveries: vi.fn().mockResolvedValue([]),
  },
  clientFor: () => ({}),
}));
vi.mock("../api/workspaces", () => ({
  workspacesApiFor: () => ({
    listWorkspaces: (...args: unknown[]) => listWorkspaces(...args),
    openWorkspace: (...args: unknown[]) => openWorkspace(...args),
  }),
}));
vi.mock("../platform", () => ({
  pickDirectory: vi.fn().mockResolvedValue(null),
  isDesktop: () => false,
  onFileDrop: () => () => undefined,
}));

import {
  type WorkspaceEventTransport,
  connectWorkspaceEvents,
  resetWorkspaceEvents,
  setWorkspaceEventTransport,
} from "../api/events";
import { LOCAL_SOURCE_ID } from "../api/source";
import { announceGrantSynced } from "../sources/grant-synced";
import { scoped } from "../sources/scope";
import { WorkspaceTree } from "../sidebar/WorkspaceTree";
import { useCanvasStore } from "../store/canvas-store";
import { NoWorkspaceAccess } from "./NoWorkspaceAccess";
import { usePreferencesStore } from "./preferences-store";
import { installDomPolyfills, TestProviders } from "./test-harness";
import {
  useWorkspaceAccessEmpty,
  useWorkspaceAccessLost,
} from "./use-access-lost";

/**
 * #632：成员开着 `/h/` 时主人改了授予的工作空间范围。core 重登同步授予后以
 * `forbidden` 结束当前那块的订阅；此前页面只把当前工作空间清空——主区一直空白，
 * 侧栏的树只列「已打开」与当前那块，收窄到一块没打开过的工作空间时连侧栏也空了。
 */

installDomPolyfills();

const timestamp = "2026-10-30T10:00:00.000Z";
const summary = (id: string, name: string): WorkspaceSummary =>
  ({
    id,
    name,
    rootPath: `/${name}`,
    color: "#5B5BD6",
    permissions: { read: true, write: true, execute: true },
    executionHostId: "",
    lastOpenedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    boards: [],
  }) as never;
const PROJ_A = summary("019ff7d1-0d12-7421-833d-2c5e8d64ed0a", "proj-a");
const PROJ_B = summary("019ff7d1-0d12-7421-833d-2c5e8d64ed0b", "proj-b");
const PROJ_C = summary("019ff7d1-0d12-7421-833d-2c5e8d64ed0c", "proj-c");

let failures: ((error: unknown) => void)[] = [];
const fake: WorkspaceEventTransport = {
  async subscribe() {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<unknown>>((_resolve, reject) => {
            failures.push(reject);
          }),
      }),
    };
  },
  onDrop: () => () => undefined,
  closedWith: () => null,
};
const settle = () => new Promise((done) => setTimeout(done, 0));

function Shell() {
  useWorkspaceAccessLost();
  const workspace = useCanvasStore((state) => state.workspace);
  return (
    <>
      <WorkspaceTree />
      <main>{!workspace && <NoWorkspaceAccess />}</main>
    </>
  );
}

/** 开着 proj-b，侧栏里已打开 `open` 这几块；然后主人把范围改成 `after`。 */
async function narrow(
  open: readonly WorkspaceSummary[],
  after: readonly WorkspaceSummary[],
) {
  listWorkspaces.mockResolvedValue([...open]);
  usePreferencesStore.setState({
    openWorkspaceKeys: open.map((item) => scoped(item.id, LOCAL_SOURCE_ID)),
  });
  useCanvasStore.getState().setWorkspace(PROJ_B as never, LOCAL_SOURCE_ID);
  render(
    <TestProviders>
      <Shell />
    </TestProviders>,
  );
  await screen.findByText("proj-b");
  const release = connectWorkspaceEvents(PROJ_B.id);
  await settle();
  listWorkspaces.mockResolvedValue([...after]);
  failures[0]!({ code: "forbidden" });
  await settle();
  return release;
}

beforeEach(() => {
  failures = [];
  setWorkspaceEventTransport(fake);
  usePreferencesStore.setState({
    locale: "zh-CN",
    collapsedWorkspaceKeys: [],
    pinnedBoardKeys: [],
    pinnedWorkspaceKeys: [],
  });
  useWorkspaceAccessEmpty.setState({ empty: false });
  info.mockReset();
  listWorkspaces.mockReset();
  openWorkspace.mockReset().mockResolvedValue(undefined);
  sessions.mockReset().mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  resetWorkspaceEvents();
  setWorkspaceEventTransport(null);
  useCanvasStore.getState().setWorkspace(null);
});

describe("授予范围收窄（#632）", () => {
  it("当前工作空间被收走：切到仍可见的下一个，侧栏不空", async () => {
    // 整台 → 只限 proj-a，成员只打开过 proj-b：这就是侧栏变空的那一次。
    const release = await narrow([PROJ_B], [PROJ_A]);

    await waitFor(() =>
      expect(useCanvasStore.getState().workspace?.id).toBe(PROJ_A.id),
    );
    expect(useCanvasStore.getState().sourceId).toBe(LOCAL_SOURCE_ID);
    expect(info).toHaveBeenCalledWith("「proj-b」已不再共享给你");
    expect(await screen.findByText("proj-a")).toBeTruthy();
    expect(screen.queryByText("proj-b")).toBeNull();
    expect(usePreferencesStore.getState().openWorkspaceKeys).toContain(
      scoped(PROJ_A.id, LOCAL_SOURCE_ID),
    );
    expect(openWorkspace).toHaveBeenCalledWith(PROJ_A.id);
    expect(screen.queryByText("没有可访问的工作空间")).toBeNull();
    release();
  });

  it("先回到侧栏里已打开的那块，而不是列表第一块", async () => {
    const release = await narrow([PROJ_B, PROJ_C], [PROJ_A, PROJ_C]);

    await waitFor(() =>
      expect(useCanvasStore.getState().workspace?.id).toBe(PROJ_C.id),
    );
    release();
  });

  it("列表还是同步之前那份：收走的那块也不再回去", async () => {
    const release = await narrow([PROJ_B], [PROJ_B, PROJ_A]);

    await waitFor(() =>
      expect(useCanvasStore.getState().workspace?.id).toBe(PROJ_A.id),
    );
    release();
  });

  it("全部收走：主区给空态，打开别的就收起", async () => {
    const release = await narrow([PROJ_B], []);

    expect(await screen.findByText("没有可访问的工作空间")).toBeTruthy();
    expect(useCanvasStore.getState().workspace).toBeNull();
    expect(useWorkspaceAccessEmpty.getState().empty).toBe(true);

    useCanvasStore.getState().setWorkspace(PROJ_A as never, LOCAL_SOURCE_ID);
    await waitFor(() =>
      expect(screen.queryByText("没有可访问的工作空间")).toBeNull(),
    );
    // 之后自己关掉工作空间是平常的空主区，不再说「没有可访问的」。
    expect(useWorkspaceAccessEmpty.getState().empty).toBe(false);
    release();
  });

  it("放宽范围：授予同步完就重取列表，新放开的直接出现，不刷新、不自动打开", async () => {
    // 两块都打开过，范围先收窄到只剩 proj-a。
    listWorkspaces.mockResolvedValue([PROJ_A]);
    usePreferencesStore.setState({
      openWorkspaceKeys: [
        scoped(PROJ_A.id, LOCAL_SOURCE_ID),
        scoped(PROJ_B.id, LOCAL_SOURCE_ID),
      ],
    });
    useCanvasStore.getState().setWorkspace(PROJ_A as never, LOCAL_SOURCE_ID);
    render(
      <TestProviders>
        <Shell />
      </TestProviders>,
    );
    await screen.findByText("proj-a");
    expect(screen.queryByText("proj-b")).toBeNull();
    const calls = listWorkspaces.mock.calls.length;

    // 放宽回整台：不撤令牌、不结束订阅，只有重登成功这一声。
    listWorkspaces.mockResolvedValue([PROJ_A, PROJ_B]);
    announceGrantSynced();

    expect(await screen.findByText("proj-b")).toBeTruthy();
    expect(listWorkspaces.mock.calls.length).toBeGreaterThan(calls);
    expect(useCanvasStore.getState().workspace?.id).toBe(PROJ_A.id);
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("等列表时用户自己打开了别的：不替他换", async () => {
    let answer: (list: WorkspaceSummary[]) => void = () => undefined;
    listWorkspaces.mockResolvedValue([PROJ_B]);
    usePreferencesStore.setState({
      openWorkspaceKeys: [scoped(PROJ_B.id, LOCAL_SOURCE_ID)],
    });
    useCanvasStore.getState().setWorkspace(PROJ_B as never, LOCAL_SOURCE_ID);
    render(
      <TestProviders>
        <Shell />
      </TestProviders>,
    );
    await screen.findByText("proj-b");
    const release = connectWorkspaceEvents(PROJ_B.id);
    await settle();
    listWorkspaces.mockImplementation(
      () => new Promise((resolve) => (answer = resolve)),
    );
    failures[0]!({ code: "forbidden" });
    await settle();
    useCanvasStore.getState().setWorkspace(PROJ_C as never, LOCAL_SOURCE_ID);
    answer([PROJ_A]);
    await settle();
    await settle();
    expect(useCanvasStore.getState().workspace?.id).toBe(PROJ_C.id);
    release();
  });
});
