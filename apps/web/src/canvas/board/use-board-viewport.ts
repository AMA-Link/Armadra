import * as React from "react";
import type { CameraState } from "@armadra/board/core";
import type { DomBoard } from "@armadra/board/dom";

import { useCanvasStore } from "@/store/canvas-store";
import { stopFollowing } from "@/realtime/session";
import { clampZoom } from "../zoom";
import { CAMERA_THROTTLE_MS, isOpeningCamera } from "../flow/use-flow-viewport";

/**
 * 相机 → 文档，节流 300 ms（与旧 `useViewportSync` 同一条规则）：连续平移时每
 * 300 ms 记一次，停手后最后一次也会落下；手势结束时立刻落一次。
 *
 * 用户自己移动相机就不再跟随别人（#327）：拖动 / 捏合 / 滚轮产生的相机变化都发生
 * 在手势期间或紧跟滚轮事件之后，程序化的 `setViewport`（打开板、跟随）不经过这里
 * 的判定，由 `flow-handle` 直接写相机。
 */
export function useBoardViewportSync(board: DomBoard): void {
  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: CameraState | null = null;
    const flush = () => {
      timer = null;
      const latest = pending;
      if (!latest || isOpeningCamera(latest)) return;
      useCanvasStore.getState().setViewport(
        { x: latest.x, y: latest.y, zoom: clampZoom(latest.zoom) },
        { source: "camera" },
      );
    };
    const stops = [
      board.on("camera", (state) => {
        pending = state;
        if (board.gestureActive()) stopFollowing();
        timer ??= setTimeout(flush, CAMERA_THROTTLE_MS);
      }),
      board.on("gesture", ({ active }) => {
        if (active || !pending) return;
        if (timer) clearTimeout(timer);
        flush();
      }),
    ];
    return () => {
      for (const stop of stops) stop();
      if (timer) clearTimeout(timer);
    };
  }, [board]);
}
