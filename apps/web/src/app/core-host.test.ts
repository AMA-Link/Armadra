import { afterEach, describe, expect, it, vi } from "vitest";

const health = vi.fn();
vi.mock("@/api/system", () => ({ systemApi: { health: () => health() } }));

import { coreHost, ensureCoreHost, setCoreHost } from "./core-host";

afterEach(() => {
  setCoreHost(undefined);
  health.mockReset();
  vi.useRealTimers();
});

describe("core host（#581）", () => {
  it("问到一次就不再问；同一时刻只有一次在途", async () => {
    health.mockResolvedValue({
      status: "ok",
      version: "1",
      platform: "win32",
      defaultShell: "pwsh",
    });
    for (let i = 0; i < 20; i += 1) ensureCoreHost();
    await vi.waitFor(() => expect(coreHost().platform).toBe("win32"));
    ensureCoreHost();
    expect(health).toHaveBeenCalledTimes(1);
  });

  it("问不到时按退避再问，请求频率有上界", async () => {
    vi.useFakeTimers();
    health.mockRejectedValue(new Error("404"));
    // 每 50 毫秒有人要一次，持续 60 秒。
    for (let tick = 0; tick < 1_200; tick += 1) {
      ensureCoreHost();
      await vi.advanceTimersByTimeAsync(50);
    }
    // 1+2+4+8+16 秒之后每 30 秒一次：60 秒里不超过 7 次；不退避是 1 200 次。
    expect(health.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(health.mock.calls.length).toBeLessThanOrEqual(7);
    expect(coreHost()).toEqual({});
  });
});
