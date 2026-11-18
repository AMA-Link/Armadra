import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { usePreferencesStore } from "@/app/preferences-store";

import {
  BACKGROUND_WEBVIEW_MAX,
  GHOST_ENTRY_HEADROOM,
  ghostEntryMax,
  setGhostIds,
  useIsGhost,
} from "./pool";

/**
 * ghost 池：条目上限比 guest 预算宽，先放进程再放条目；`useIsGhost` 跟着画布适配器
 * 报告的 ghost 集合走。条目本身的退休、复活、逐出在 `canvas/board/board-adapter.test.ts`。
 */

beforeEach(() => {
  usePreferencesStore.setState({
    browser: {
      discard: true,
      discardMinutes: 5,
      backgroundMax: 8,
      startPage: "",
    },
  });
});

afterEach(() => setGhostIds(new Set()));

describe("ghostEntryMax", () => {
  it("默认是 guest 预算加上余量", () => {
    expect(ghostEntryMax()).toBe(BACKGROUND_WEBVIEW_MAX + GHOST_ENTRY_HEADROOM);
  });

  it("条目上限比 guest 预算宽，先放进程再放条目", () => {
    /*
      两层用同一个设置项但管的不是一件事：`./background` 超出预算的释放**进
      程**（节点还在），这里超出的摘掉**条目**（回来是一张白纸）。一样大的
      时候池总是先动手——逐出在每一次同步时判，回收的定时器十五秒才醒一次
      ——于是温和的那一步永远轮不到。这一条钉住那段余量。
    */
    usePreferencesStore.getState().setBrowserPreference("backgroundMax", 2);
    expect(ghostEntryMax()).toBeGreaterThan(2);
    expect(ghostEntryMax()).toBe(2 + GHOST_ENTRY_HEADROOM);
  });

  it("上限跟着设置走，调小之后下一次读就变小", () => {
    usePreferencesStore.getState().setBrowserPreference("backgroundMax", 3);
    expect(ghostEntryMax()).toBe(3 + GHOST_ENTRY_HEADROOM);
    usePreferencesStore.getState().setBrowserPreference("backgroundMax", 2);
    expect(ghostEntryMax()).toBe(2 + GHOST_ENTRY_HEADROOM);
  });
});

describe("useIsGhost", () => {
  it("适配器报告的 ghost 集合变了，订阅者跟着变", () => {
    const view = renderHook(() => useIsGhost("b1"));
    expect(view.result.current).toBe(false);
    act(() => setGhostIds(new Set(["b1"])));
    expect(view.result.current).toBe(true);
    act(() => setGhostIds(new Set(["b2"])));
    expect(view.result.current).toBe(false);
  });
});
