// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useCanvasZoom } from "./canvas-zoom";
import { getStageView, publishStageView, useStageView } from "./stage-view";

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
});
