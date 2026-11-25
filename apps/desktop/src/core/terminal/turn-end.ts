import type { EventBus } from "../bus";
import type { TerminalManager } from "./manager";

/**
 * 轮末（hook / ACP 报 idle 或 waiting）放掉该节点 Agent 自己持有的驱动租约，
 * 排队的投递不必再等 120 秒空闲窗口（#1011）。人持有的租约不动。
 * 返回取消订阅函数。
 */
export function releaseDriveAtTurnEnd(
  bus: EventBus,
  manager: Pick<TerminalManager, "releaseAgentDrive">,
): () => void {
  return bus.on("workspace.event", ({ event }) => {
    if (event.type !== "agent.status") return;
    const status = (event as { status?: { nodeId?: unknown; state?: unknown } })
      .status;
    if (status?.state !== "idle" && status?.state !== "waiting") return;
    if (typeof status.nodeId !== "string") return;
    manager.releaseAgentDrive(status.nodeId);
  });
}
