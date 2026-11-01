import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useCompactLayout } from "./layout";
import {
  DESKTOP_NARROW,
  PHONE_LANDSCAPE,
  PHONE_PORTRAIT,
  TABLET_LANDSCAPE,
  TABLET_PORTRAIT,
  evaluate,
  type Viewport,
} from "./layout.testkit";

/**
 * 转屏：手机横竖屏都在手机布局里，所以 `useCompactLayout` 在转屏前后都是真，
 * 订阅方（连接页、画布、焦点页、底部导航、工作面板）不会因此卸载重挂；
 * 平板与电脑窗口跨过判据时才切换。
 */
describe("useCompactLayout 转屏", () => {
  const original = window.matchMedia;
  afterEach(() => {
    window.matchMedia = original;
  });

  function install(initial: Viewport) {
    let viewport = initial;
    const listeners = new Set<() => void>();
    window.matchMedia = ((query: string) => ({
      get matches() {
        return evaluate(query, viewport);
      },
      media: query,
      addEventListener: (_: string, listener: () => void) =>
        listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) =>
        listeners.delete(listener),
    })) as unknown as typeof window.matchMedia;
    return (next: Viewport) => {
      viewport = next;
      for (const listener of listeners) listener();
    };
  }

  it("手机竖屏转横屏：始终是手机布局", () => {
    const rotate = install(PHONE_PORTRAIT);
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useCompactLayout();
    });
    expect(result.current).toBe(true);
    act(() => rotate(PHONE_LANDSCAPE));
    expect(result.current).toBe(true);
    act(() => rotate(PHONE_PORTRAIT));
    expect(result.current).toBe(true);
    // 值没变，订阅方不会重渲染。
    expect(renders).toBe(1);
  });

  it("平板转屏不换布局；窗口压窄到 767 以下才换", () => {
    const rotate = install(TABLET_PORTRAIT);
    const { result } = renderHook(() => useCompactLayout());
    expect(result.current).toBe(false);
    act(() => rotate(TABLET_LANDSCAPE));
    expect(result.current).toBe(false);
    act(() => rotate(DESKTOP_NARROW));
    expect(result.current).toBe(true);
  });
});
