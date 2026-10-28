import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const health = vi.fn();
vi.mock("@/api/system", () => ({ systemApi: { health: () => health() } }));
let desktop = false;
vi.mock("@/platform", () => ({ isDesktop: () => desktop }));

import {
  resetBrowserAvailability,
  useCanCreateBrowser,
  useHeadlessBrowser,
} from "./availability";

afterEach(() => {
  act(() => resetBrowserAvailability());
  health.mockReset();
  desktop = false;
});

describe("browser availability", () => {
  it("reads the core's headlessBrowser capability once", async () => {
    health.mockResolvedValue({
      status: "ok",
      version: "1",
      capabilities: { headlessBrowser: true },
    });
    const first = renderHook(() => useCanCreateBrowser());
    await waitFor(() => expect(first.result.current).toBe(true));
    renderHook(() => useHeadlessBrowser());
    expect(health).toHaveBeenCalledTimes(1);
  });

  it("treats an old core without capabilities as no browser", async () => {
    health.mockResolvedValue({ status: "ok", version: "1" });
    const { result } = renderHook(() => useCanCreateBrowser());
    await waitFor(() => expect(health).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it("does not ask when disabled, and always allows on the desktop shell", () => {
    renderHook(() => useHeadlessBrowser(false));
    expect(health).not.toHaveBeenCalled();
    desktop = true;
    const { result } = renderHook(() => useCanCreateBrowser());
    expect(result.current).toBe(true);
    expect(health).not.toHaveBeenCalled();
  });

  /** 背后没有 core（#581）：重挂载、多个节点头一起要，失败后的请求也有上界。 */
  it("backs off after a failure instead of asking on every mount", async () => {
    vi.useFakeTimers();
    try {
      health.mockRejectedValue(new Error("404"));
      for (let tick = 0; tick < 300; tick += 1) {
        const hooks = [0, 1, 2].map(() =>
          renderHook(() => useHeadlessBrowser()),
        );
        await act(() => vi.advanceTimersByTimeAsync(100));
        for (const hook of hooks) hook.unmount();
      }
      // 30 秒里不断重挂：1+2+4+8+16 秒的退避，最多 5～6 次；不退避是上千次。
      expect(health.mock.calls.length).toBeGreaterThanOrEqual(4);
      expect(health.mock.calls.length).toBeLessThanOrEqual(6);
    } finally {
      vi.useRealTimers();
    }
  });
});
