import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { CanvasNode } from "@armadra/shared";

import { StreamSurface } from "./StreamSurface";

/**
 * 服务端先发一条 error 消息再关流（`core/browser/stream.ts::closeWith`）：
 * 画面按其中的原因码选提示，而不是对所有「不可用」都说没装 Chromium。
 */

const sockets = vi.hoisted(() => ({
  current: undefined as
    | undefined
    | {
        binaryType: string;
        onopen: (() => void) | null;
        onmessage: ((event: { data: unknown }) => void) | null;
        onclose: ((event: { code: number }) => void) | null;
        close: () => void;
      },
}));

vi.mock("@/store/canvas-store", () => {
  const state = { workspace: { id: "w1" } };
  return {
    useCanvasStore: <T,>(selector: (value: typeof state) => T) =>
      selector(state),
  };
});

vi.mock("@/api/sockets", () => ({ browserStreamUrl: () => "ws://stream" }));

vi.mock("../../api/source", () => ({
  openSourceSocket: () => {
    sockets.current = {
      binaryType: "",
      onopen: null,
      onmessage: null,
      onclose: null,
      close: () => undefined,
    };
    return sockets.current;
  },
}));

vi.mock("../NodeShell", () => ({
  NodeShell: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

const node = {
  id: "n1",
  type: "browser",
  data: { kind: "browser", url: "https://example.com" },
} as unknown as CanvasNode;

function mount() {
  render(
    <StreamSurface
      id="n1"
      node={node}
      selected={false}
      collapsed={false}
      focused={false}
    />,
  );
}

function fail(code: string) {
  act(() => {
    sockets.current?.onmessage?.({
      data: JSON.stringify({ type: "error", code, message: "x" }),
    });
  });
}

describe("StreamSurface 的不可用提示", () => {
  beforeEach(() => {
    sockets.current = undefined;
  });
  afterEach(cleanup);

  it("没有可用的浏览器时指到 Chromium", () => {
    mount();
    fail("browser_unavailable");
    expect(screen.getByText(/Chromium/)).toBeTruthy();
  });

  it("别的原因码不再说成没装 Chromium", () => {
    mount();
    fail("browser_failed");
    expect(screen.queryByText(/Chromium/)).toBeNull();
    expect(screen.getByText("浏览器没有启动成功，稍后再试。")).toBeTruthy();
  });

  it("已有人在看是另一条提示", () => {
    mount();
    fail("browser_viewer_present");
    expect(screen.getByText(/一个观看者/)).toBeTruthy();
  });
});
