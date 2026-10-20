import type { ProgramStatus } from "./api/terminals.js";
import type { ActivityPhase, SessionActivity } from "./domain/timeline.js";
import { type HumanNeed, agentHumanNeed, isProcessGone } from "./human-need.js";

/**
 * 统一的状态显示（设计 §2.5）：节点头胶囊、侧栏圆点、小地图描边、抽屉、铃铛、
 * 推送都从 `sessionDisplay()` 取结果，不再各自推导。
 *
 * 输入是三层信息：粗状态（`agent_status`，由 hook 归约，语义不变）、细粒度
 * 活动（core 在内存里算的 `SessionActivity`）、进程事实（`alive`、`sleeping`）；
 * 程序自报的状态（OSC）在这里合并。纯函数，没有时间参数。
 *
 * 几条口径（修 S1–S8）：
 *  - 「出错」只有一个：`tone = failed` 表示最近一个回合以错误结束；
 *    `need = error` 表示出错且还没人看过。
 *  - 进程已经没了（`alive === false`）不会有人能回答：`need` 恒为空、`busy` 为假。
 *  - 程序自报只在没有活的上报（也没有活动）时才画；有上报时上报说了算。
 */

export const STATUS_TONES = [
  "working",
  "attention",
  "failed",
  "queued",
  "paused",
  "unread",
  "idle",
  "done",
] as const;
export type StatusTone = (typeof STATUS_TONES)[number];

/** 显示只读这些字段；会话摘要、状态帧都满足它。 */
export interface DisplayStatus {
  state?: string | undefined;
  stateSource?: string | undefined;
  pendingId?: string | undefined;
  errored?: boolean | undefined;
  interrupted?: boolean | undefined;
  unread?: boolean | undefined;
  /** 重启后从库里读回来的旧行：判决成立，但不冒充「刚跑完」。 */
  restored?: boolean | undefined;
}

export interface SessionDisplayInput {
  status?: DisplayStatus | undefined;
  activity?: SessionActivity | undefined;
  alive?: boolean | undefined;
  sleeping?: boolean | undefined;
  program?: Pick<ProgramStatus, "state" | "kind" | "progress"> | undefined;
  /** 覆盖 `status.unread`（侧栏 / 铃铛按本地「看过」记录给）。 */
  unread?: boolean | undefined;
}

export interface SessionDisplay {
  tone: StatusTone;
  phase: ActivityPhase | "unknown";
  /** i18n 键，例如 `status.tool`、`status.awaitingApproval`。 */
  labelKey: string;
  /** 工具标题等，截到 60 字。 */
  detail?: string;
  /** 即 `agentHumanNeed` 的结果；通知、铃铛、推送都用它。 */
  need: HumanNeed | null;
  /** 回合进行中（取代 streaming、turns、target-state 各自的判断）。 */
  busy: boolean;
  since?: number;
  /** 程序自报的进度（0–100），只在它说「在跑」时有。 */
  progress?: number;
}

/** 这些阶段是进程 / 会话生命周期，进程死了也照实显示。 */
const LIFECYCLE: ReadonlySet<ActivityPhase> = new Set([
  "starting",
  "restoring",
  "switching",
  "sleeping",
  "exited",
]);

const BUSY_PHASES: ReadonlySet<ActivityPhase> = new Set([
  "submitting",
  "thinking",
  "tool",
  "awaiting_approval",
  "awaiting_input",
  "responding",
]);

const LABEL: Record<ActivityPhase, string> = {
  starting: "status.starting",
  restoring: "status.restoring",
  idle: "status.idle",
  submitting: "status.submitting",
  thinking: "status.thinking",
  tool: "status.tool",
  awaiting_approval: "status.awaitingApproval",
  awaiting_input: "status.awaitingInput",
  responding: "status.responding",
  switching: "status.switching",
  sleeping: "status.sleeping",
  exited: "status.exited",
};

export const DETAIL_MAX_CHARS = 60;

function clip(text: string): string {
  const chars = Array.from(text.trim());
  return chars.length <= DETAIL_MAX_CHARS
    ? chars.join("")
    : `${chars.slice(0, DETAIL_MAX_CHARS - 1).join("")}…`;
}

function detailOf(activity: SessionActivity | undefined): string | undefined {
  const detail = activity?.detail;
  if (activity === undefined || detail === undefined) return undefined;
  let text: string | undefined;
  switch (activity.phase) {
    case "tool":
      text = detail.label ?? detail.toolKind;
      break;
    case "starting":
      text = detail.step ?? detail.label;
      break;
    case "restoring":
      text =
        detail.count !== undefined && detail.count > 0
          ? String(detail.count)
          : undefined;
      break;
    default:
      text = detail.label;
  }
  return text === undefined || text.trim() === "" ? undefined : clip(text);
}

/** 上报在这个 core 进程里是活的：它说了算（`observed` 只是猜测，不算）。 */
function reportedLive(status: DisplayStatus | undefined): boolean {
  return Boolean(
    status?.state && !status.restored && status.stateSource !== "observed",
  );
}

interface Effective {
  state: string | undefined;
  pendingId: string | undefined;
  errored: boolean;
  interrupted: boolean;
  restored: boolean;
  progress: number | undefined;
}

/** 合并粗状态与程序自报（S5）。 */
function effective(input: SessionDisplayInput): Effective {
  const status = input.status;
  const program = input.program;
  const base = {
    state: status?.state,
    pendingId: status?.pendingId,
    errored: status?.errored === true || status?.state === "error",
    interrupted: status?.interrupted === true,
    restored: status?.restored === true,
    progress: undefined as number | undefined,
  };
  if (reportedLive(status) || input.activity !== undefined) {
    if (
      status?.state === "working" &&
      program?.state === "working" &&
      program.progress !== undefined
    ) {
      base.progress = program.progress;
    }
    return base;
  }
  switch (program?.state) {
    case "working":
      return {
        ...base,
        state: "working",
        ...(program.progress !== undefined
          ? { progress: program.progress }
          : {}),
      };
    case "blocked":
      return {
        ...base,
        state: program.kind === "question" ? "waiting" : "blocked",
      };
    case "done":
      return { ...base, state: "done" };
    case "error":
      return { ...base, state: "done", errored: true };
    default:
      return base;
  }
}

export function sessionDisplay(input: SessionDisplayInput): SessionDisplay {
  const activity = input.activity;
  const eff = effective(input);
  const unread = input.unread ?? input.status?.unread ?? false;
  const gone = isProcessGone(input.alive);
  const sleeping = input.sleeping === true;
  const outcome = activity?.lastOutcome?.kind;

  // 「最近一个回合怎么结束的」只在没有新回合在跑时看；活动层的结局补上报缺的。
  const activityIdle = activity === undefined || activity.phase === "idle";
  const errored =
    eff.errored ||
    (activityIdle && (outcome === "failed" || outcome === "refused"));
  const interrupted =
    eff.interrupted ||
    (activityIdle && (outcome === "cancelled" || outcome === "limit"));

  let need = agentHumanNeed({
    state: eff.state,
    pendingId: eff.pendingId,
    errored,
    unread,
    alive: input.alive,
  });
  if (need === null && !gone && !sleeping) {
    if (activity?.phase === "awaiting_approval") need = "approval";
    else if (activity?.phase === "awaiting_input") need = "input";
  }
  if (sleeping) need = need === "error" ? need : null;

  // 阶段。
  let phase: SessionDisplay["phase"];
  if (sleeping) phase = "sleeping";
  else if (need === "approval") phase = "awaiting_approval";
  else if (need === "input") phase = "awaiting_input";
  else if (activity !== undefined) {
    phase = gone && !LIFECYCLE.has(activity.phase) ? "exited" : activity.phase;
  } else if (gone) phase = "exited";
  else if (eff.state === "working") phase = "unknown";
  else if (eff.state === "done") phase = "idle";
  else phase = "unknown";

  const busy =
    !gone &&
    !sleeping &&
    ((phase !== "unknown" && BUSY_PHASES.has(phase)) ||
      (phase === "unknown" && eff.state === "working"));

  // 色调。
  let tone: StatusTone;
  const done = eff.state === "done" || outcome === "done";
  if (need === "approval" || need === "input") tone = "attention";
  else if (
    phase === "starting" ||
    phase === "restoring" ||
    phase === "switching"
  )
    tone = "queued";
  else if (busy) tone = "working";
  else if (errored) tone = "failed";
  else if (sleeping) tone = "paused";
  else if (interrupted) tone = "paused";
  else if (done && unread && !eff.restored) tone = "unread";
  else if (done) tone = "done";
  else tone = "idle";

  // 文案键。
  let labelKey: string;
  if (phase === "idle" || phase === "exited") {
    if (errored && outcome === "refused" && activityIdle)
      labelKey = "status.refused";
    else if (errored) labelKey = "status.failed";
    else if (interrupted && outcome === "limit" && activityIdle)
      labelKey = "status.limit";
    else if (interrupted) labelKey = "status.interrupted";
    else if (phase === "exited") labelKey = LABEL.exited;
    else if (done) labelKey = "status.done";
    else labelKey = LABEL.idle;
  } else if (phase === "unknown") {
    labelKey = eff.state === "working" ? "status.working" : "status.unknown";
  } else {
    labelKey = LABEL[phase];
  }

  const detail =
    activity !== undefined && phase === activity.phase
      ? detailOf(activity)
      : undefined;
  return {
    tone,
    phase,
    labelKey,
    need,
    busy,
    ...(detail !== undefined ? { detail } : {}),
    ...(activity !== undefined ? { since: activity.since } : {}),
    ...(busy && eff.progress !== undefined ? { progress: eff.progress } : {}),
  };
}
