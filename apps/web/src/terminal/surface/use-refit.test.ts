import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import type { SurfaceRefs } from "./refs";
import { useRefit } from "./use-refit";

vi.mock("./dom-spacing", () => ({ resyncDomRendererSpacing: () => false }));

function makeRefs(options: {
  visible?: boolean;
  proposed?: { cols: number; rows: number } | undefined;
  size?: { cols: number; rows: number };
}) {
  const terminal = {
    cols: options.size?.cols ?? 80,
    rows: options.size?.rows ?? 24,
    refresh: vi.fn(),
  };
  const fit = {
    proposeDimensions: vi.fn(() => options.proposed),
    fit: vi.fn(() => {
      if (options.proposed) {
        terminal.cols = options.proposed.cols;
        terminal.rows = options.proposed.rows;
      }
    }),
  };
  const resize = vi.fn();
  const refs = {
    terminalRef: { current: terminal },
    fitRef: { current: fit },
    visibleRef: { current: options.visible ?? true },
    gridRef: { current: null },
    transportRef: { current: { resize } },
  } as unknown as SurfaceRefs;
  return { refs, fit, resize };
}

describe("useRefit 的返回值（#614）", () => {
  it("不在视口里：没量，返回 false，不发 resize", () => {
    const { refs, resize } = makeRefs({ visible: false });
    const { result } = renderHook(() => useRefit(refs));
    expect(result.current()).toBe(false);
    expect(resize).not.toHaveBeenCalled();
  });

  it("容器量不出尺寸：返回 false，不 fit、不发 resize", () => {
    const { refs, fit, resize } = makeRefs({ proposed: undefined });
    const { result } = renderHook(() => useRefit(refs));
    expect(result.current()).toBe(false);
    expect(fit.fit).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();
  });

  it("量到了、和当前一致：返回 true，不发 resize", () => {
    const { refs, resize } = makeRefs({
      proposed: { cols: 80, rows: 24 },
      size: { cols: 80, rows: 24 },
    });
    const { result } = renderHook(() => useRefit(refs));
    expect(result.current()).toBe(true);
    expect(resize).not.toHaveBeenCalled();
  });

  it("量到了、不同：fit 并发 resize，返回 true", () => {
    const { refs, fit, resize } = makeRefs({
      proposed: { cols: 69, rows: 18 },
    });
    const { result } = renderHook(() => useRefit(refs));
    expect(result.current()).toBe(true);
    expect(fit.fit).toHaveBeenCalled();
    expect(resize).toHaveBeenCalledWith(69, 18);
  });
});
