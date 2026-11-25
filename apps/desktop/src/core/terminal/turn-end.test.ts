import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../bus";
import { releaseDriveAtTurnEnd } from "./turn-end";

const status = (nodeId: string, state: string) => ({
  workspaceId: "w",
  event: { type: "agent.status", status: { nodeId, state } },
});

describe("轮末释放驱动租约（#1011）", () => {
  it("idle 与 waiting 释放，working 与其他事件不动", () => {
    const bus = new EventBus();
    const releaseAgentDrive = vi.fn(() => true);
    const off = releaseDriveAtTurnEnd(bus, { releaseAgentDrive });
    bus.emit("workspace.event", status("n1", "working"));
    bus.emit("workspace.event", {
      workspaceId: "w",
      event: { type: "agent.subagent" },
    });
    expect(releaseAgentDrive).not.toHaveBeenCalled();
    bus.emit("workspace.event", status("n1", "idle"));
    bus.emit("workspace.event", status("n2", "waiting"));
    expect(releaseAgentDrive.mock.calls).toEqual([["n1"], ["n2"]]);
    off();
    bus.emit("workspace.event", status("n3", "idle"));
    expect(releaseAgentDrive).toHaveBeenCalledTimes(2);
  });
});
