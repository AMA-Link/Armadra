import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ResizeDragEvent } from "@xyflow/react";

import { useStableResizeHandlers, type ResizeHandlers } from "./stable-resize";

/**
 * #819：交给 `NodeResizer` 的回调身份一变，React Flow 就在手势中途换绑把手，
 * 手指拉伸到第一帧就断、`onResizeEnd` 永远不来。
 */

const event = {} as ResizeDragEvent;
const params = { x: 1, y: 2, width: 300, height: 200 };

describe("useStableResizeHandlers", () => {
  it("重渲时三个回调的身份不变", () => {
    const { result, rerender } = renderHook(
      (handlers: ResizeHandlers) => useStableResizeHandlers(handlers),
      { initialProps: { onResize: () => undefined } as ResizeHandlers },
    );
    const first = result.current;
    rerender({ onResize: () => undefined, onResizeEnd: () => undefined });
    expect(result.current.onResizeStart).toBe(first.onResizeStart);
    expect(result.current.onResize).toBe(first.onResize);
    expect(result.current.onResizeEnd).toBe(first.onResizeEnd);
  });

  it("转发到最新一次渲染给的回调", () => {
    const stale = vi.fn();
    const fresh = vi.fn();
    const { result, rerender } = renderHook(
      (handlers: ResizeHandlers) => useStableResizeHandlers(handlers),
      { initialProps: { onResizeEnd: stale } as ResizeHandlers },
    );
    rerender({ onResizeEnd: fresh });
    result.current.onResizeEnd(event, params);
    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledWith(event, params);
  });

  it("没给的回调调了也不抛", () => {
    const { result } = renderHook(() => useStableResizeHandlers({}));
    expect(() => {
      result.current.onResizeStart(event, params);
      result.current.onResize(event, { ...params, direction: [1, 1] });
      result.current.onResizeEnd(event, params);
    }).not.toThrow();
  });
});
