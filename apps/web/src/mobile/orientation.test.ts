import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { nativeBridge } from "./native-bridge";

/** 让页面看起来在 Capacitor 原生壳里，插件是给的这个。 */
function inApp(plugin: Record<string, unknown> | undefined) {
  vi.stubGlobal("location", new URL("capacitor://localhost/"));
  vi.stubGlobal("Capacitor", {
    isNativePlatform: () => true,
    Plugins: plugin ? { ArmadraNative: plugin } : {},
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("界面方向（#827）", () => {
  it("不在原生 App 里：不能锁定，调用答 false", async () => {
    const bridge = nativeBridge();
    expect(bridge.canLockOrientation).toBe(false);
    await expect(bridge.setOrientation("portrait")).resolves.toBe(false);
  });

  it("原生插件有 setOrientation：按 { mode } 调用；旧安装包没有时答 false", async () => {
    const setOrientation = vi.fn(async () => undefined);
    inApp({ setOrientation });
    const bridge = nativeBridge();
    expect(bridge.canLockOrientation).toBe(true);
    await expect(bridge.setOrientation("landscape")).resolves.toBe(true);
    expect(setOrientation).toHaveBeenCalledWith({ mode: "landscape" });
    await expect(bridge.setOrientation("sideways" as never)).resolves.toBe(
      false,
    );
    expect(setOrientation).toHaveBeenCalledTimes(1);

    inApp({});
    expect(nativeBridge().canLockOrientation).toBe(false);
    await expect(nativeBridge().setOrientation("portrait")).resolves.toBe(
      false,
    );
  });

  it("选了就记在这台设备上并交给原生；启动时按记下的再交一次，跟随系统不调", async () => {
    const setOrientation = vi.fn(async () => undefined);
    inApp({ setOrientation });
    const first = await import("./orientation");
    expect(first.useOrientationStore.getState().orientation).toBe("auto");
    first.applyStoredOrientation();
    expect(setOrientation).not.toHaveBeenCalled();

    first.useOrientationStore.getState().setOrientation("portrait");
    expect(localStorage.getItem(first.ORIENTATION_KEY)).toBe("portrait");
    expect(setOrientation).toHaveBeenLastCalledWith({ mode: "portrait" });

    vi.resetModules();
    setOrientation.mockClear();
    const next = await import("./orientation");
    expect(next.useOrientationStore.getState().orientation).toBe("portrait");
    next.applyStoredOrientation();
    expect(setOrientation).toHaveBeenCalledWith({ mode: "portrait" });
  });

  it("存着认不得的值时按跟随系统", async () => {
    localStorage.setItem("armadra.mobile.orientation", "upside-down");
    const { useOrientationStore } = await import("./orientation");
    expect(useOrientationStore.getState().orientation).toBe("auto");
  });
});
