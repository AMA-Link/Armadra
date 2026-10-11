import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "@armadra/shared";

const access = vi.hoisted(() => ({ member: false }));
vi.mock("@/app/use-access", () => ({
  useAccess: () => ({ member: access.member }),
}));

import { useCanvasStore } from "@/store/canvas-store";
import { useCanShareCurrent } from "./use-can-share";

const open = (sourceId: string) =>
  act(() =>
    useCanvasStore
      .getState()
      .setWorkspace({ id: "w1", name: "Book" } as Workspace, sourceId),
  );

afterEach(() => {
  cleanup();
  access.member = false;
  act(() => useCanvasStore.getState().setWorkspace(null));
});

describe("能不能分享打开着的工作空间（#301 B5）", () => {
  it("只有主人、且工作空间在这台电脑上", () => {
    const hook = renderHook(() => useCanShareCurrent());
    expect(hook.result.current).toBe(false);
    open("local");
    hook.rerender();
    expect(hook.result.current).toBe(true);
    open("someone-else");
    hook.rerender();
    expect(hook.result.current).toBe(false);
  });

  it("成员不给", () => {
    access.member = true;
    open("local");
    const hook = renderHook(() => useCanShareCurrent());
    expect(hook.result.current).toBe(false);
  });
});
