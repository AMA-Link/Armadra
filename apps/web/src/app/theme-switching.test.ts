import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 主题切换抑制过渡（设计系统 §8.6）：写 `data-theme` 之前给 `<html>` 加
 * `data-theme-switching`，强制重算样式，下一帧摘掉——`tokens.css` 里那条
 * `[data-theme-switching] * { transition: none !important }` 因此只活一帧。
 */

async function freshStore() {
  vi.resetModules();
  return import("./preferences-store");
}

const root = document.documentElement;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  delete root.dataset.theme;
  delete root.dataset.themeSwitching;
  delete root.dataset.backdrop;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("切主题时的一帧抑制", { timeout: 30_000 }, () => {
  it("切主题当拍就带 data-theme-switching，下一帧摘掉", async () => {
    const { applyInitialTheme, syncDocumentPreferences, usePreferencesStore } =
      await freshStore();
    usePreferencesStore.getState().setTheme("dark");
    applyInitialTheme();
    const stop = syncDocumentPreferences();
    expect(root.dataset.themeSwitching).toBeUndefined();

    usePreferencesStore.getState().setTheme("light");
    expect(root.dataset.theme).toBe("light");
    expect(root.dataset.themeSwitching).toBe("");

    vi.advanceTimersToNextFrame();
    expect(root.dataset.themeSwitching).toBeUndefined();
    expect(root.dataset.theme).toBe("light");
    stop();
  });

  it("标记先于 data-theme 写入：写主题的那一刻抑制已经生效", async () => {
    const { applyInitialTheme, syncDocumentPreferences, usePreferencesStore } =
      await freshStore();
    usePreferencesStore.getState().setTheme("dark");
    applyInitialTheme();
    const stop = syncDocumentPreferences();

    const order: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) order.push(record.attributeName ?? "");
    });
    observer.observe(root, { attributes: true });
    usePreferencesStore.getState().setTheme("light");
    order.push(...observer.takeRecords().map((r) => r.attributeName ?? ""));
    observer.disconnect();
    expect(order.indexOf("data-theme-switching")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("data-theme-switching")).toBeLessThan(
      order.indexOf("data-theme"),
    );
    stop();
  });

  it("系统外观变了（偏好是 system）同样抑制", async () => {
    const { applyInitialTheme, syncDocumentPreferences, usePreferencesStore } =
      await freshStore();
    usePreferencesStore.getState().setSystemTheme("light");
    applyInitialTheme();
    const stop = syncDocumentPreferences();
    expect(root.dataset.themeSwitching).toBeUndefined();
    usePreferencesStore.getState().setSystemTheme("dark");
    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.themeSwitching).toBe("");
    vi.advanceTimersToNextFrame();
    expect(root.dataset.themeSwitching).toBeUndefined();
    stop();
  });

  it("首次同步和不相干的偏好变化不抑制", async () => {
    const { applyInitialTheme, syncDocumentPreferences, usePreferencesStore } =
      await freshStore();
    applyInitialTheme();
    const stop = syncDocumentPreferences();
    expect(root.dataset.themeSwitching).toBeUndefined();
    usePreferencesStore.getState().setTranslucentWindow(false);
    expect(root.dataset.themeSwitching).toBeUndefined();
    stop();
  });

  it("换色板也是整页换色，同样只活一帧", async () => {
    const { applyInitialTheme, syncDocumentPreferences, usePreferencesStore } =
      await freshStore();
    applyInitialTheme();
    const stop = syncDocumentPreferences();
    usePreferencesStore.getState().setBackdrop("mist");
    expect(root.dataset.themeSwitching).toBe("");
    vi.advanceTimersToNextFrame();
    expect(root.dataset.themeSwitching).toBeUndefined();
    stop();
  });
});
