import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 窗口背景色板与半透明开关（AMA-Link/Armadra#474）：默认与改动之前一致，存进
 * localStorage，写到 `<html>`，只在主题偏好或开关变了时交给桌面壳。
 */

async function freshStore() {
  vi.resetModules();
  return import("./preferences-store");
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.backdrop;
  delete document.documentElement.dataset.translucent;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { armadra?: unknown }).armadra;
});

describe("背景色板偏好", () => {
  it("默认 plain、半透明开", async () => {
    const { usePreferencesStore } = await freshStore();
    const state = usePreferencesStore.getState();
    expect(state.backdrop).toBe("plain");
    expect(state.translucentWindow).toBe(true);
  });

  it("改了存进 localStorage，下次启动读回；认不出的值落回 plain", async () => {
    const first = await freshStore();
    first.usePreferencesStore.getState().setBackdrop("meadow");
    first.usePreferencesStore.getState().setTranslucentWindow(false);
    const second = await freshStore();
    expect(second.usePreferencesStore.getState().backdrop).toBe("meadow");
    expect(second.usePreferencesStore.getState().translucentWindow).toBe(false);
    localStorage.setItem("armadra.backdrop", "neon");
    const third = await freshStore();
    expect(third.usePreferencesStore.getState().backdrop).toBe("plain");
  });

  it("首帧之前与每次变化都写到 <html>", async () => {
    const { applyInitialTheme, syncDocumentPreferences, usePreferencesStore } =
      await freshStore();
    const root = document.documentElement;
    applyInitialTheme();
    expect(root.dataset.backdrop).toBe("plain");
    expect(root.dataset.translucent).toBe("true");
    const stop = syncDocumentPreferences();
    usePreferencesStore.getState().setBackdrop("dusk");
    usePreferencesStore.getState().setTranslucentWindow(false);
    expect(root.dataset.backdrop).toBe("dusk");
    expect(root.dataset.translucent).toBe("false");
    stop();
  });

  it("桌面壳只在主题偏好或开关变了时收到一次", async () => {
    const setAppearance = vi.fn(() => Promise.resolve({ ok: true }));
    (window as { armadra?: unknown }).armadra = { windows: { setAppearance } };
    const { syncDocumentPreferences, usePreferencesStore } = await freshStore();
    const stop = syncDocumentPreferences();
    expect(setAppearance).toHaveBeenLastCalledWith({
      theme: "system",
      translucent: true,
    });
    usePreferencesStore.getState().setBackdrop("mist");
    expect(setAppearance).toHaveBeenCalledTimes(1);
    usePreferencesStore.getState().setTheme("light");
    expect(setAppearance).toHaveBeenLastCalledWith({
      theme: "light",
      translucent: true,
    });
    usePreferencesStore.getState().setTranslucentWindow(false);
    expect(setAppearance).toHaveBeenLastCalledWith({
      theme: "light",
      translucent: false,
    });
    expect(setAppearance).toHaveBeenCalledTimes(3);
    stop();
  });
});
