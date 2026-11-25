import type { CoreContext } from "../main";
import { SCREEN_GATE_LINES } from "../agent/screen-gate";
import { GROK_ANSWER_SETTING, cardAnswerGate } from "../agent/grok-answer";
import { settingsDomain } from "../settings";
import {
  type TimelineDomain,
  rowLiveness,
  timelineDomainOf,
} from "../timeline";
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
  timeline:
    | (Pick<TimelineDomain, "setLiveness"> & {
        readonly sources: Pick<TimelineDomain["sources"], "setTerminalFacts">;
      })
    | undefined = timelineDomainOf(context.server),
): void {
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
    env: (sessionId, name) => manager.envOf(sessionId, name),
    // 终端卡代答的门（契约 §127）：设置、grok 进程自己的 argv（权限模式）、它跑的那个
    // 可执行文件的版本都过了才建审批记录。清单、设置、模式三样过了才探版本。
    answerCards: async (_sessionId, _nodeId, launch) => {
      const gate = await cardAnswerGate({
        setting: settingsDomain()?.settings.get(GROK_ANSWER_SETTING),
        launch,
      });
      return gate.open ? { open: true } : { open: false, reason: gate.reason };
    },
    screen: async (sessionId) => {
      try {
        return (await manager.capture(sessionId, SCREEN_GATE_LINES, false))
          .data;
      } catch {
        return undefined;
      }
    },
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
