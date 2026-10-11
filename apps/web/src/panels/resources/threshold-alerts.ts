/**
 * 会话内存越线提醒：读 core 发的 `resources.threshold`（契约 §27.4）。
 *
 * 越线的判定、阈值（设置 `resources.memoryWarnBytes`）与去重都在 core：同一次
 * 运行只发一次，回落到阈值九成以下才重新上膛。页面不再自己判，只做两件事：
 *
 *  - 收到事件提醒一次：窗口在后台走系统通知（点开定位到节点），在前台走 toast；
 *  - 记下「core 说这个会话越线了」，徽标据此变色，样本回落到九成以下时忘掉，
 *    与 core 的重新上膛对上。
 *
 * 只是提醒：不终止、不休眠、不做任何处置（设计 §8）。
 */
import { useEffect } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import type { ResourcesThresholdEvent } from "@armadra/shared";

import { onWorkspaceEvent } from "@/api/events";
import { t } from "@/app/preferences-store";
import { requestCenterOnNode } from "@/canvas/flow/flow-context";
import { notify } from "@/platform";
import { useCanvasStore } from "@/store/canvas-store";
import { formatMetricBytes } from "./metrics";

/** 与 core `resources/thresholds.ts` 的 `REARM_RATIO` 相同。 */
export const REARM_RATIO = 0.9;

export interface ReportedThreshold {
  readonly value: number;
  readonly threshold: number;
}

interface ThresholdState {
  /** 会话 id → core 报的那一次越线。 */
  readonly over: Readonly<Record<string, ReportedThreshold>>;
  report: (sessionId: string, reported: ReportedThreshold) => void;
  forget: (sessionId: string) => void;
}

export const useThresholdStore = create<ThresholdState>((set) => ({
  over: {},
  report: (sessionId, reported) =>
    set((state) => ({ over: { ...state.over, [sessionId]: reported } })),
  forget: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.over)) return state;
      const next = { ...state.over };
      delete next[sessionId];
      return { over: next };
    }),
}));

/**
 * 徽标该不该画成越线：core 报过这个会话，而且当前样本还没回落到九成以下。
 * 测不出来（`null`）时照 core 说的算——不知道不等于回落了。
 */
export function stillOver(
  reported: ReportedThreshold | undefined,
  memoryBytes: number | null | undefined,
): boolean {
  if (reported === undefined) return false;
  if (typeof memoryBytes !== "number" || !Number.isFinite(memoryBytes)) {
    return true;
  }
  return memoryBytes >= reported.threshold * REARM_RATIO;
}

function inBackground(): boolean {
  return (
    typeof document !== "undefined" && (document.hidden || !document.hasFocus())
  );
}

/** 一条 `resources.threshold`：记下、提醒一次。只认 `memory`。 */
export function handleThresholdEvent(event: ResourcesThresholdEvent): void {
  if (event.metric !== "memory") return;
  useThresholdStore.getState().report(event.sessionId, {
    value: event.value,
    threshold: event.threshold,
  });
  const title = t("resources.memory.alertTitle");
  const body = t("resources.memory.alertBody", {
    value: formatMetricBytes(event.value),
    limit: formatMetricBytes(event.threshold),
  });
  if (!inBackground()) {
    toast.warning(title, { description: body });
    return;
  }
  const nodeId = event.nodeId;
  void notify(title, body, {
    onClick:
      nodeId === undefined
        ? undefined
        : () => {
            useCanvasStore.getState().selectNodes([nodeId]);
            requestCenterOnNode(nodeId);
          },
  });
}

/** App 挂一次。 */
export function useThresholdAlerts(): void {
  useEffect(
    () => onWorkspaceEvent("resources.threshold", handleThresholdEvent),
    [],
  );
}
