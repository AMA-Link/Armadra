import { describe, expect, it, vi } from "vitest";
import { EventBus, type WorkspaceEvent } from "../bus";

type Emitted = { readonly workspaceId: string; readonly event: WorkspaceEvent };
import { releaseDriveAtTurnEnd } from "./turn-end";

const status = (nodeId: string, state: string): Emitted =>
  ({
    workspaceId: "w",
    event: { type: "agent.status", status: { nodeId, state } },
  }) as unknown as Emitted;

describe("轮末释放驱动租约（#1011）", () => {
  it("转入 done 时释放；working、waiting、重复的 done 不放", () => {
    const bus = new EventBus();
    const releaseAgentDrive = vi.fn(() => true);
    const off = releaseDriveAtTurnEnd(bus, { releaseAgentDrive });
    bus.emit("workspace.event", status("n1", "working"));
    bus.emit("workspace.event", status("n2", "waiting"));
    bus.emit("workspace.event", {
      workspaceId: "w",
      event: { type: "agent.subagent" },
    } as unknown as Emitted);
    expect(releaseAgentDrive).not.toHaveBeenCalled();
    bus.emit("workspace.event", status("n1", "done"));
    expect(releaseAgentDrive.mock.calls).toEqual([["n1"]]);
    bus.emit("workspace.event", status("n1", "done"));
    expect(releaseAgentDrive).toHaveBeenCalledTimes(1);
    bus.emit("workspace.event", status("n1", "working"));
    bus.emit("workspace.event", status("n1", "done"));
    expect(releaseAgentDrive).toHaveBeenCalledTimes(2);
    off();
    bus.emit("workspace.event", status("n3", "done"));
    expect(releaseAgentDrive).toHaveBeenCalledTimes(2);
  });
});
