import type { EventBus } from "../bus";
import type { TerminalManager } from "./manager";

/**
 * 轮末（行状态变为 `done`）放掉该节点终端会话上的 Agent 租约，排队的投递不必
 * 再等 120 秒空闲窗口（#1011）。租约的持有者是投递方 Agent（不是目标节点自己），
 * 目标一轮结束就让位给排队的投递，这是想要的行为。人持有、人接管、控制器持有的
 * 租约不动。`waiting`（有问题等人回答）说明这一轮还没结束，不放。
 *
 * 只在状态**转入** `done` 时放：重复的 Stop 或迟到的旧事件不会放掉刚拿到的租约。
 * 返回取消订阅函数。
 */
export function releaseDriveAtTurnEnd(
  bus: EventBus,
  manager: Pick<TerminalManager, "releaseAgentDrive">,
): () => void {
  const last = new Map<string, string>();
  return bus.on("workspace.event", ({ event }) => {
    if (event.type !== "agent.status") return;
    const status = (event as { status?: { nodeId?: unknown; state?: unknown } })
      .status;
    if (typeof status?.nodeId !== "string") return;
    const state = String(status.state);
    const previous = last.get(status.nodeId);
    last.set(status.nodeId, state);
    if (state === "done" && previous !== "done") {
      manager.releaseAgentDrive(status.nodeId);
    }
  });
}
