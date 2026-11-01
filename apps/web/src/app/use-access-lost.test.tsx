import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const info = vi.fn();
vi.mock("@/ui/toast", () => ({
  toast: { info: (...args: unknown[]) => info(...args) },
}));

import {
  type WorkspaceEventTransport,
  connectWorkspaceEvents,
  resetWorkspaceEvents,
  setWorkspaceEventTransport,
} from "../api/events";
import { useCanvasStore } from "../store/canvas-store";
import { usePreferencesStore } from "./preferences-store";
import { useWorkspaceAccessLost } from "./use-access-lost";

/**
 * 服务器壳上撤销共享：core 以 `forbidden` 结束这块工作空间的事件订阅。此前页面照旧
 * 停在那块画布上（侧栏「当前工作空间永远在树里」），之后的每一次读写都是
 * 403，却没有任何提示。
 */

const WORKSPACE = "019ff7d1-0d12-7421-833d-2c5e8d64ed22";

/** 订阅：要么一直等，要么按测试给的错误结束；`cursors` 交出一帧位置帧。 */
let failures: ((error: unknown) => void)[] = [];
let cursors: (() => void)[] = [];
const fake: WorkspaceEventTransport = {
  async subscribe() {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<unknown>>((resolve, reject) => {
            failures.push(reject);
            cursors.push(() =>
              resolve({
                done: false,
                value: { type: "cursor", cursor: 1, floor: 0, watermark: 1 },
              }),
            );
          }),
      }),
    };
  },
  onDrop: () => () => undefined,
  closedWith: () => null,
};
const settle = () => new Promise((done) => setTimeout(done, 0));
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    {children}
  </QueryClientProvider>
);

beforeEach(() => {
  failures = [];
  cursors = [];
  setWorkspaceEventTransport(fake);
  usePreferencesStore.setState({ locale: "zh-CN" });
  info.mockReset();
});
afterEach(() => {
  resetWorkspaceEvents();
  setWorkspaceEventTransport(null);
  useCanvasStore.getState().setWorkspace(null);
});

describe("useWorkspaceAccessLost", () => {
  it("订阅以 forbidden 结束时离开这块工作空间，并说一句为什么", async () => {
    useCanvasStore
      .getState()
      .setWorkspace({ id: WORKSPACE, name: "共享项目" } as never);
    renderHook(() => useWorkspaceAccessLost(), { wrapper });
    const release = connectWorkspaceEvents(WORKSPACE);
    await settle();
    failures[0]!({ code: "forbidden" });
    await settle();
    expect(useCanvasStore.getState().workspace).toBeNull();
    expect(info).toHaveBeenCalledWith("「共享项目」已不再共享给你");
    release();
  });

  it("订着的工作空间被删除或归档：离开它、关掉它的标签，提示已不可用（契约 §89）", async () => {
    useCanvasStore
      .getState()
      .setWorkspace({ id: WORKSPACE, name: "共享项目" } as never);
    usePreferencesStore.getState().openWorkspaceTab(WORKSPACE);
    renderHook(() => useWorkspaceAccessLost(), { wrapper });
    const release = connectWorkspaceEvents(WORKSPACE);
    await settle();
    cursors[0]!();
    await settle();
    failures.at(-1)!({ code: "not_found" });
    await settle();
    expect(useCanvasStore.getState().workspace).toBeNull();
    expect(info).toHaveBeenCalledWith("「共享项目」已不可用");
    expect(usePreferencesStore.getState().openWorkspaceKeys).not.toContainEqual(
      expect.stringContaining(WORKSPACE),
    );
    release();
  });

  it("别的失败只是断线，留在原处", async () => {
    useCanvasStore
      .getState()
      .setWorkspace({ id: WORKSPACE, name: "共享项目" } as never);
    renderHook(() => useWorkspaceAccessLost(), { wrapper });
    const release = connectWorkspaceEvents(WORKSPACE);
    await settle();
    failures[0]!(new Error("connection closed"));
    await settle();
    expect(useCanvasStore.getState().workspace?.id).toBe(WORKSPACE);
    expect(info).not.toHaveBeenCalled();
    release();
  });
});
