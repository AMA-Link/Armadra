import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStatus } from "@armadra/shared";

import {
  NOTIFY_THROTTLE_MS,
  createAgentNotifier,
  notificationFor,
  notificationText,
  type NotifierDeps,
} from "./notifications";

const NODE = "019ff7d1-0d12-7421-833d-2c5e8d64ed21";
const WORKSPACE = "019ff7d1-0d12-7421-833d-2c5e8d64ed22";

function status(partial: Partial<AgentStatus> = {}): AgentStatus {
  return {
    nodeId: NODE,
    workspaceId: WORKSPACE,
    agentId: "claude",
    unread: false,
    verified: true,
    restored: false,
    updatedAt: "2026-09-04T10:00:00.000Z",
    ...partial,
  };
}

interface Harness {
  deps: NotifierDeps;
  notify: ReturnType<typeof vi.fn>;
  playSound: ReturnType<typeof vi.fn>;
  background: { value: boolean };
  settings: { notifyNeedsYou: boolean; sound: boolean };
}

function harness(): Harness {
  const notify = vi.fn();
  const playSound = vi.fn();
  const background = { value: true };
  const settings = { notifyNeedsYou: true, sound: true };
  return {
    notify,
    playSound,
    background,
    settings,
    deps: {
      notify,
      playSound,
      isBackground: () => background.value,
      titleOf: () => "claude · 前端",
      settings: () => settings,
      now: () => Date.now(),
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-04T10:00:00.000Z"));
});

afterEach(() => vi.useRealTimers());

describe("notificationFor", () => {
  it("fires on entering approval or waiting, once per state", () => {
    expect(notificationFor(undefined, status({ state: "blocked" }))).toBe(
      "approval",
    );
    expect(
      notificationFor(
        status({ state: "blocked" }),
        status({ state: "blocked" }),
      ),
    ).toBeNull();
    // 等授权和等回答是两件事，切换时再叫一次。
    expect(
      notificationFor(
        status({ state: "blocked" }),
        status({ state: "waiting" }),
      ),
    ).toBe("input");
  });

  it("treats a pending approval id as approval whatever the state says", () => {
    expect(
      notificationFor(
        status({ state: "working" }),
        status({ state: "working", pendingId: "p1" }),
      ),
    ).toBe("approval");
  });

  it("fires for a failed turn nobody has looked at, and only once", () => {
    const failed = status({ state: "done", errored: true, unread: true });
    expect(notificationFor(status({ state: "working" }), failed)).toBe("error");
    expect(notificationFor(failed, failed)).toBeNull();
    // 看过之后（未读清掉）不再提醒。
    expect(
      notificationFor(
        status({ state: "working" }),
        status({ state: "done", errored: true, unread: false }),
      ),
    ).toBeNull();
  });

  it("never fires for a finished turn, idle, working or unknown", () => {
    for (const next of [
      status({ state: "done", unread: true }),
      status({ state: "working" }),
      status(),
    ]) {
      expect(notificationFor(status({ state: "working" }), next)).toBeNull();
    }
  });

  it("stays quiet for a restored row", () => {
    expect(
      notificationFor(undefined, status({ state: "blocked", restored: true })),
    ).toBeNull();
  });
});

describe("notificationText", () => {
  it("is Chinese and names the node", () => {
    expect(notificationText("approval", "claude").title).toBe(
      "claude 等待审批",
    );
    expect(notificationText("input", "claude").title).toBe("claude 等你回答");
    expect(notificationText("error", "claude").title).toBe("claude 出错了");
  });
});

describe("createAgentNotifier", () => {
  it("stays silent while the window is in the foreground", () => {
    const h = harness();
    h.background.value = false;
    const notifier = createAgentNotifier(h.deps);
    notifier.handle(status({ state: "blocked" }));
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.playSound).not.toHaveBeenCalled();
  });

  it("notifies and plays a sound when the window is in the background", () => {
    const h = harness();
    const notifier = createAgentNotifier(h.deps);
    notifier.handle(status({ state: "working" }));
    notifier.handle(status({ state: "blocked" }));
    expect(h.notify).toHaveBeenCalledWith(
      "claude · 前端 等待审批",
      expect.any(String),
      NODE,
    );
    expect(h.playSound).toHaveBeenCalledTimes(1);
  });

  it("does not notify when a turn finishes", () => {
    const h = harness();
    const notifier = createAgentNotifier(h.deps);
    notifier.handle(status({ state: "working" }));
    notifier.handle(status({ state: "done", unread: true }));
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.playSound).not.toHaveBeenCalled();
  });

  it("throttles to one alert per node per 5s", () => {
    const h = harness();
    const notifier = createAgentNotifier(h.deps);
    notifier.handle(status({ state: "blocked" }));
    expect(h.notify).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(NOTIFY_THROTTLE_MS - 1);
    notifier.handle(status({ state: "waiting" }));
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.playSound).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    notifier.handle(status({ state: "blocked" }));
    expect(h.notify).toHaveBeenCalledTimes(2);
    expect(h.playSound).toHaveBeenCalledTimes(2);
  });

  it("throttles per node, not globally", () => {
    const h = harness();
    const notifier = createAgentNotifier(h.deps);
    notifier.handle(status({ state: "blocked" }));
    notifier.handle(status({ nodeId: "other", state: "blocked" }));
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it("honours the notification and sound switches independently", () => {
    const h = harness();
    h.settings.notifyNeedsYou = false;
    const notifier = createAgentNotifier(h.deps);
    notifier.handle(status({ state: "blocked" }));
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.playSound).toHaveBeenCalledTimes(1);

    h.settings.sound = false;
    h.settings.notifyNeedsYou = true;
    vi.advanceTimersByTime(NOTIFY_THROTTLE_MS);
    notifier.handle(status({ state: "waiting" }));
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.playSound).toHaveBeenCalledTimes(1);
  });
});
