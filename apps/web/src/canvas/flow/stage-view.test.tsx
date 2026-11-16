// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useCanvasZoom } from "./canvas-zoom";
import {
  ZOOM_READOUT_MS,
  getStageView,
  publishStageView,
  useStageView,
  useStageZoomReadout,
} from "./stage-view";

afterEach(() => publishStageView(null));

describe("stage-view", () => {
  it("没有画布时是 {0,0,1} 与 0 尺寸，Dock 读到 1", () => {
    const view = renderHook(() => useStageView());
    expect(view.result.current).toEqual({
      x: 0,
      y: 0,
      zoom: 1,
      width: 0,
      height: 0,
    });
    expect(renderHook(() => useCanvasZoom()).result.current).toBe(1);
  });

  it("引擎推进来的视口：订阅者拿到新值，内容没变不通知", () => {
    let renders = 0;
    const view = renderHook(() => {
      renders += 1;
      return useStageView();
    });
    const zoom = renderHook(() => useCanvasZoom());
    act(() =>
      publishStageView({ x: 10, y: 20, zoom: 0.5, width: 800, height: 600 }),
    );
    expect(view.result.current).toMatchObject({ x: 10, y: 20, zoom: 0.5 });
    expect(zoom.result.current).toBe(0.5);
    const before = renders;
    act(() =>
      publishStageView({ x: 10, y: 20, zoom: 0.5, width: 800, height: 600 }),
    );
    expect(renders).toBe(before);
    act(() => publishStageView(null));
    expect(getStageView().zoom).toBe(1);
  });

  it("档位读数：首次变化立即更新，连续变化限频，停手后落到最终值", () => {
    vi.useFakeTimers();
    try {
      let renders = 0;
      const readout = renderHook(() => {
        renders += 1;
        return useStageZoomReadout();
      });
      const at = (zoom: number) =>
        act(() => publishStageView({ x: 0, y: 0, zoom, width: 1, height: 1 }));
      at(0.5);
      expect(readout.result.current).toBe(0.5);
      const before = renders;
      at(0.6);
      at(0.7);
      at(0.8);
      expect(readout.result.current).toBe(0.5);
      expect(renders).toBe(before);
      act(() => void vi.advanceTimersByTime(ZOOM_READOUT_MS));
      expect(readout.result.current).toBe(0.8);
    } finally {
      vi.useRealTimers();
    }
  });
});
