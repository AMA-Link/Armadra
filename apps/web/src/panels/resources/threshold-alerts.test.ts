import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notify = vi.fn();
const toastWarning = vi.fn();
const centerOn = vi.fn();

vi.mock("@/platform", () => ({
  notify: (...args: unknown[]) => notify(...args),
}));
vi.mock("sonner", () => ({
  toast: { warning: (...args: unknown[]) => toastWarning(...args) },
}));
vi.mock("@/canvas/flow/flow-context", () => ({
  requestCenterOnNode: (...args: unknown[]) => centerOn(...args),
}));

import type { ResourcesThresholdEvent } from "@armadra/shared";
import { dispatchWorkspaceEvent } from "@/api/events";
import { usePreferencesStore } from "@/app/preferences-store";
import { renderHook } from "@testing-library/react";
import {
  handleThresholdEvent,
  stillOver,
  useThresholdAlerts,
  useThresholdStore,
} from "./threshold-alerts";

/** 内存越线提醒读 core 的 `resources.threshold`（契约 §27.4，#326）。 */

const GB = 1024 * 1024 * 1024;

const event = (
  patch: Partial<ResourcesThresholdEvent> = {},
): ResourcesThresholdEvent => ({
  type: "resources.threshold",
  sessionId: "s-1",
  nodeId: "n-1",
  metric: "memory",
  value: 3 * GB,
  threshold: 2 * GB,
  ...patch,
});

beforeEach(() => {
  vi.clearAllMocks();
  usePreferencesStore.setState({ locale: "zh-CN" });
  useThresholdStore.setState({ over: {} });
});
afterEach(() => vi.restoreAllMocks());

describe("resources.threshold 提醒", () => {
  it("前台：toast 一条，正文用事件里的数字", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    handleThresholdEvent(event());
    expect(toastWarning).toHaveBeenCalledTimes(1);
    expect(toastWarning.mock.calls[0]?.[1]).toEqual({
      description: expect.stringMatching(/3(\.0)? GB.*2(\.0)? GB/),
    });
    expect(notify).not.toHaveBeenCalled();
    expect(useThresholdStore.getState().over["s-1"]).toEqual({
      value: 3 * GB,
      threshold: 2 * GB,
    });
  });

  it("后台：系统通知，点开定位到节点", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    handleThresholdEvent(event());
    expect(notify).toHaveBeenCalledTimes(1);
    expect(toastWarning).not.toHaveBeenCalled();
    const options = notify.mock.calls[0]?.[2] as { onClick?: () => void };
    options.onClick?.();
    expect(centerOn).toHaveBeenCalledWith("n-1");
  });

  it("不认识的指标不记也不提醒", () => {
    handleThresholdEvent(event({ metric: "cpu" }));
    expect(toastWarning).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(useThresholdStore.getState().over).toEqual({});
  });

  it("App 挂上之后经事件流收到", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const hook = renderHook(() => useThresholdAlerts());
    dispatchWorkspaceEvent(event());
    expect(toastWarning).toHaveBeenCalledTimes(1);
    hook.unmount();
    dispatchWorkspaceEvent(event({ sessionId: "s-2" }));
    expect(toastWarning).toHaveBeenCalledTimes(1);
  });

  it("徽标：报过且没回落到九成以下才算越线；测不出来照 core 说的算", () => {
    const reported = { value: 3 * GB, threshold: 2 * GB };
    expect(stillOver(undefined, 3 * GB)).toBe(false);
    expect(stillOver(reported, 2 * GB)).toBe(true);
    expect(stillOver(reported, 1.8 * GB)).toBe(true);
    expect(stillOver(reported, 1.79 * GB)).toBe(false);
    expect(stillOver(reported, null)).toBe(true);
  });
});
