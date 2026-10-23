import { afterEach, describe, expect, it } from "vitest";
import {
  clearSplashShown,
  markSplashShown,
  resetSplashPhase,
  setSplashPhase,
  shouldShowSplash,
  splashJustDismissed,
  splashPhase,
  subscribeSplashPhase,
} from "./session";

afterEach(() => {
  clearSplashShown();
  resetSplashPhase();
});

describe("splash session guard", () => {
  it("plays on the first load of a page session and never again", () => {
    expect(shouldShowSplash(true)).toBe(true);
    markSplashShown();
    // ⌘W / 托盘只是藏窗口，WebView 与它的 sessionStorage 都还在。
    expect(shouldShowSplash(true)).toBe(false);
  });

  it("plays again once the page session is gone", () => {
    markSplashShown();
    // ⌘Q 之后重新打开是新进程新 WebView，标记随之消失。
    clearSplashShown();
    expect(shouldShowSplash(true)).toBe(true);
  });

  it("never plays when the preference is off", () => {
    expect(shouldShowSplash(false)).toBe(false);
    markSplashShown();
    expect(shouldShowSplash(false)).toBe(false);
  });

  it("stores the mark under a stable key", () => {
    markSplashShown();
    expect(sessionStorage.getItem("armadra.splash.shown")).toBe("1");
  });
});

describe("splash phase", () => {
  it("starts idle and only counts leaving / done as just dismissed", () => {
    expect(splashPhase()).toBe("idle");
    for (const [phase, dismissed] of [
      ["playing", false],
      ["leaving", true],
      ["done", true],
      ["idle", false],
    ] as const) {
      setSplashPhase(phase);
      expect(splashJustDismissed()).toBe(dismissed);
    }
  });

  it("notifies subscribers once per change and stops after unsubscribe", () => {
    let calls = 0;
    const off = subscribeSplashPhase(() => (calls += 1));
    setSplashPhase("playing");
    setSplashPhase("playing");
    expect(calls).toBe(1);
    off();
    setSplashPhase("leaving");
    expect(calls).toBe(1);
  });
});
