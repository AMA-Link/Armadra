import { afterEach, describe, expect, it, vi } from "vitest";
import { sendPump } from ".";
import { programBlocks } from "../collab/program-block";
import { install as installAgents } from ".";
import { fixture, type Fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import { install as installCanvas } from "../canvas/routes";

/**
 * 装配点的接线（`agent/index.ts`）：总线上的 `terminal.program` 事件经
 * `programFreeHook` 叫醒出队泵。撤掉那一行接线，这里就会变红。
 */

let open: Fixture | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  programBlocks.clear();
  open?.close();
  open = undefined;
});

function emit(status: { state: string } | undefined, nodeId = "n1"): void {
  open!.bus.emit("workspace.event", {
    workspaceId: "w1",
    event: {
      type: "terminal.program",
      sessionId: "s1",
      nodeId,
      ...(status === undefined ? {} : { status }),
    },
  } as never);
}

describe("the terminal.program wiring", () => {
  it("wakes the send pump when a node leaves blocked, and only then", () => {
    open = fixture([installWorkspaces, installCanvas, installAgents]);
    const free = vi.spyOn(sendPump(), "noteFree").mockImplementation(() => {});
    emit({ state: "working" });
    expect(free).not.toHaveBeenCalled();
    emit({ state: "blocked" });
    expect(free).not.toHaveBeenCalled();
    emit({ state: "working" });
    expect(free).toHaveBeenCalledTimes(1);
    expect(free).toHaveBeenCalledWith("n1");
    emit({ state: "working" });
    expect(free).toHaveBeenCalledTimes(1);
  });
});
