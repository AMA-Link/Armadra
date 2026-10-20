/**
 * 「需要人处理」的分类（契约 §81）。
 *
 * 通知面板、铃铛徽标、系统通知与推送共用这一个文件里的函数：什么算「该叫人」
 * 只有一份定义。空闲、未知、运行中、正常完成都不是——它们是状态，不是请求。
 *
 *  - `approval`：等待审批（权限请求，`pendingId` 或 `blocked`）。
 *  - `input`：等待输入或回答（`waiting`，包括未答的提问）。
 *  - `error`：回合出错结束，且还没有人看过（`errored` + `unread`）。
 *  - `handoff`：交接已冻结、等人批准（`prepared`）。
 */

export const HUMAN_NEEDS = ["approval", "input", "error", "handoff"] as const;
export type HumanNeed = (typeof HUMAN_NEEDS)[number];

/** 分类只读这几个字段；会话摘要、状态帧、镜像条目都满足它。 */
export interface AgentNeedSubject {
  state?: string | undefined;
  pendingId?: string | undefined;
  errored?: boolean | undefined;
  unread?: boolean | undefined;
  /** 进程已经没了：不会再有人能回答它。缺省按活着算。 */
  alive?: boolean | undefined;
}

/**
 * 进程已经没了（`alive` 明确为 `false`）。缺省按活着算；`sessionDisplay` 与
 * 这里共用这一个判断，节点、侧栏、铃铛、推送对「已死」的口径才一致。
 */
export function isProcessGone(alive: boolean | undefined): boolean {
  return alive === false;
}

/** 一个 Agent 节点此刻是否在等人；同时满足多条时审批优先。 */
export function agentHumanNeed(subject: AgentNeedSubject): HumanNeed | null {
  if (isProcessGone(subject.alive)) return null;
  if (subject.pendingId || subject.state === "blocked") return "approval";
  if (subject.state === "waiting") return "input";
  if (
    (subject.state === "error" || subject.errored === true) &&
    subject.unread === true
  ) {
    return "error";
  }
  return null;
}

/** 交接记录：只有「已冻结、没人批准」要人处理；已入信箱的在等目标 Agent。 */
export function handoffHumanNeed(state: string): HumanNeed | null {
  return state === "prepared" ? "handoff" : null;
}

/** 审批与等待回答：Agent 停在提示符上，往它的终端写字会替人回答。 */
export function isAwaitingHuman(subject: AgentNeedSubject): boolean {
  const need = agentHumanNeed(subject);
  return need === "approval" || need === "input";
}
