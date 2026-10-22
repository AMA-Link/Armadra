import { beforeEach, describe, expect, it, vi } from "vitest";

/** `window:appearance` 对着假的 `nativeTheme` 与窗口。 */

const theme = vi.hoisted(() => ({ themeSource: "system" as string }));

class FakeWindow {
  destroyed = false;
  vibrancy: (string | null)[] = [];
  isDestroyed() {
    return this.destroyed;
  }
  setVibrancy(value: string | null) {
    this.vibrancy.push(value);
  }
}

const windows = vi.hoisted(() => [] as unknown[]) as FakeWindow[];

vi.mock("electron", () => ({
  nativeTheme: theme,
  BrowserWindow: { getAllWindows: () => windows },
}));

import {
  applyToNewWindow,
  resetWindowAppearance,
  setWindowAppearance,
} from "./appearance";

beforeEach(() => {
  theme.themeSource = "system";
  windows.length = 0;
  resetWindowAppearance();
});

describe("window:appearance", () => {
  it("主题偏好写进 themeSource，侧栏材质跟着应用主题走", () => {
    expect(
      setWindowAppearance({ theme: "light", translucent: true }, "darwin"),
    ).toEqual({ ok: true });
    expect(theme.themeSource).toBe("light");
    expect(
      setWindowAppearance({ theme: "system", translucent: true }, "darwin"),
    ).toEqual({ ok: true });
    expect(theme.themeSource).toBe("system");
  });

  it("macOS 上关掉半透明：每扇活着的窗口都摘掉材质", () => {
    const open = new FakeWindow();
    const gone = new FakeWindow();
    gone.destroyed = true;
    windows.push(open, gone);
    setWindowAppearance({ theme: "dark", translucent: false }, "darwin");
    expect(open.vibrancy).toEqual([null]);
    expect(gone.vibrancy).toEqual([]);
    setWindowAppearance({ theme: "dark", translucent: true }, "darwin");
    expect(open.vibrancy).toEqual([null, "sidebar"]);
  });

  it("别的平台只改主题，不碰材质", () => {
    const open = new FakeWindow();
    windows.push(open);
    setWindowAppearance({ theme: "dark", translucent: false }, "win32");
    expect(theme.themeSource).toBe("dark");
    expect(open.vibrancy).toEqual([]);
  });

  it("坏请求答 false，什么都不改", () => {
    const open = new FakeWindow();
    windows.push(open);
    expect(setWindowAppearance({ theme: "sepia" }, "darwin")).toEqual({
      ok: false,
    });
    expect(theme.themeSource).toBe("system");
    expect(open.vibrancy).toEqual([]);
  });

  it("新窗口按最后一次的开关挂材质", () => {
    setWindowAppearance({ theme: "light", translucent: false }, "darwin");
    const fresh = new FakeWindow();
    applyToNewWindow(fresh as never, "darwin");
    expect(fresh.vibrancy).toEqual([null]);
  });
});
