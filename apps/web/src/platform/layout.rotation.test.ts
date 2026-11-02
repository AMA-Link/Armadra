import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { isPhoneLandscape, useCompactLayout } from "./layout";
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
 * 转屏（#715）：手机竖屏是手机布局、横屏是电脑布局，所以 `useCompactLayout` 跟着
 * 转屏切换，订阅方（画布浮层、焦点页、底部导航、工作面板）各自换形态；画布本身
 * 不随它卸载（`app/App` 里 `FlowWorkspace` 两种布局共用）。平板与电脑窗口跨过
 * 767px 才切换。
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

  it("手机竖屏转横屏：手机布局换成电脑布局，转回来再换回", () => {
    const rotate = install(PHONE_PORTRAIT);
    const { result } = renderHook(() => ({
      compact: useCompactLayout(),
      landscape: isPhoneLandscape(),
    }));
    expect(result.current).toEqual({ compact: true, landscape: false });
    act(() => rotate(PHONE_LANDSCAPE));
    expect(result.current).toEqual({ compact: false, landscape: true });
    act(() => rotate(PHONE_PORTRAIT));
    expect(result.current).toEqual({ compact: true, landscape: false });
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
