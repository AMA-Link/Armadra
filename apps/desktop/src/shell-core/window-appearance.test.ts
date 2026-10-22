import { describe, expect, it } from "vitest";

import {
  DEFAULT_APPEARANCE,
  vibrancyFor,
  windowAppearance,
} from "./window-appearance";

describe("window:appearance 的请求", () => {
  it("收三种主题偏好与布尔开关", () => {
    for (const theme of ["system", "light", "dark"] as const) {
      expect(windowAppearance({ theme, translucent: false })).toEqual({
        theme,
        translucent: false,
      });
    }
  });

  it("形状不对答 null，壳不改任何东西", () => {
    expect(windowAppearance(null)).toBeNull();
    expect(windowAppearance("dark")).toBeNull();
    expect(windowAppearance({ theme: "sepia", translucent: true })).toBeNull();
    expect(windowAppearance({ theme: "dark", translucent: "yes" })).toBeNull();
    expect(windowAppearance({ theme: "dark" })).toBeNull();
  });

  it("默认与改动之前的窗口一致：跟随系统、半透明", () => {
    expect(DEFAULT_APPEARANCE).toEqual({ theme: "system", translucent: true });
  });
});

describe("材质", () => {
  it("只有 macOS 且开着半透明才挂 sidebar 材质", () => {
    expect(vibrancyFor(DEFAULT_APPEARANCE, "darwin")).toBe("sidebar");
    expect(
      vibrancyFor({ theme: "light", translucent: false }, "darwin"),
    ).toBeNull();
    expect(vibrancyFor(DEFAULT_APPEARANCE, "win32")).toBeNull();
    expect(vibrancyFor(DEFAULT_APPEARANCE, "linux")).toBeNull();
  });
});
