import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  closed: new Set<(code: number) => void>(),
  opened: new Set<() => void>(),
  error: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock("../api/ws", async (original) => {
  const actual = await original<typeof import("../api/ws")>();
  return {
    ...actual,
    onControlClosed: (listener: (code: number) => void) => {
      mocks.closed.add(listener);
      return () => mocks.closed.delete(listener);
    },
    onControlOpened: (listener: () => void) => {
      mocks.opened.add(listener);
      return () => mocks.opened.delete(listener);
    },
  };
});

vi.mock("@/ui/toast", () => ({
  toast: { error: mocks.error, dismiss: mocks.dismiss },
}));

import { CLOSE_EXPIRED, CLOSE_REVOKED } from "../api/ws";
import { useControlNotices } from "./use-control-notices";

const close = (code: number) => {
  for (const listener of [...mocks.closed]) listener(code);
};
const open = () => {
  for (const listener of [...mocks.opened]) listener();
};

beforeEach(() => {
  mocks.closed.clear();
  mocks.opened.clear();
  mocks.error.mockReset();
  mocks.dismiss.mockReset();
});

describe("useControlNotices", () => {
  it("收起「登录已过期」那条，一旦控制面重新连上（#706）", () => {
    const { unmount } = renderHook(() => useControlNotices());
    close(CLOSE_EXPIRED);
    expect(mocks.error).toHaveBeenCalledWith(expect.any(String), {
      id: `control-closed-${CLOSE_EXPIRED}`,
    });
    open();
    expect(mocks.dismiss).toHaveBeenCalledWith(
      `control-closed-${CLOSE_EXPIRED}`,
    );
    // 已经收过的不再收。
    mocks.dismiss.mockReset();
    open();
    expect(mocks.dismiss).not.toHaveBeenCalled();
    unmount();
    expect(mocks.closed.size).toBe(0);
    expect(mocks.opened.size).toBe(0);
  });

  it("授权收回（4403）不在这里说，也就没有要收的", () => {
    renderHook(() => useControlNotices());
    close(CLOSE_REVOKED);
    open();
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.dismiss).not.toHaveBeenCalled();
  });
});
