import type { CoreContext } from "../main";
import { rowLiveness, timelineDomainOf } from "../timeline";
import type { TerminalManager } from "./manager";

/**
 * 终端域与会话时间线之间的接线（`install.ts` 装配时调一次）。
 *
 *   * 存活情况：重启后没有活动记录的会话，按真实的存活补 `idle` / `sleeping` /
 *     `exited`（契约 §82）；
 *   * 状态读取槽要的两个会话事实：PTY 的进程号与是否在远程主机
 *     （`timeline/sources/state-slot.ts`）。
 */
export function linkTimeline(
  context: CoreContext,
  manager: TerminalManager,
): void {
  const timeline = timelineDomainOf(context.server);
  timeline?.setLiveness((sessionId) =>
    manager.isAlive(sessionId)
      ? "alive"
      : rowLiveness(context.db.database, sessionId) === "sleeping"
        ? "sleeping"
        : "gone",
  );
  timeline?.sources.setTerminalFacts({
    pid: (sessionId) => manager.pidOf(sessionId),
    remote: (sessionId) => manager.isRemote(sessionId),
  });
}

/** 会话起来了：让时间线按节点开状态读取槽（槽不等任何上报）。 */
export function sessionStarted(
  context: CoreContext,
  nodeId: string | null,
  sessionId: string,
): void {
  if (nodeId !== null) {
    timelineDomainOf(context.server)?.sources.onSessionStart(nodeId, sessionId);
  }
}
