/**
 * 状态显示的页面侧入口（acp-progressive-view §2.5、B8）。
 *
 * 节点头胶囊与光晕、侧栏圆点与分区、抽屉、铃铛与系统通知、小地图描边都从
 * 共享层的 `sessionDisplay()` 取结果；这个文件只做两件事：
 *
 *  1. 把页面手上的各种形状（会话行、镜像条目、节点头的三份输入）喂给它；
 *  2. 把它的结果映射成各视图要画的东西（胶囊、光晕、分区、通知色调）。
 *
 * 任何视图都不该再自己读 `state` / `unread` / `errored` 去判断「现在是什么
 * 状态」；要画什么就在这里加一个映射，让所有视图同时拿到。
 */
import {
  sessionDisplay,
  type HumanNeed,
  type ProgramStatus,
  type SessionActivity,
  type SessionDisplay,
  type StatusTone,
  type TimelineToolStatus,
} from "@armadra/shared";

import type { ServiceStatus } from "../services/probe";
import type { MirroredStatus } from "./status-store";

/**
 * `sessionDisplay().labelKey` 可能给出的全部键（文案在 `i18n/status.ts`）。
 * 共享层只返回字符串，页面这边列一遍，让键有一个看得见的引用，也让测试能
 * 逐个核对中英文案都在。
 */
export const STATUS_LABEL_KEYS = [
  "status.starting",
  "status.restoring",
  "status.idle",
  "status.submitting",
  "status.thinking",
  "status.tool",
  "status.awaitingApproval",
  "status.awaitingInput",
  "status.responding",
  "status.switching",
  "status.sleeping",
  "status.exited",
  "status.working",
  "status.unknown",
  "status.done",
  "status.failed",
  "status.refused",
  "status.interrupted",
  "status.limit",
] as const;

/** 画布节点光晕：每种光晕对应一种色调，和胶囊、圆点、小地图描边同色。 */
export type AgentGlow = "working" | "attention" | "failed" | "unread";

/** 节点头胶囊。 */
export interface HeaderPill {
  tone: StatusTone;
  /** i18n 键（`i18n/status.ts`）。 */
  labelKey: string;
  /** 工具标题等，由调用方决定要不要拼在文案后面。 */
  detail?: string;
}

export interface HeaderState {
  pill?: HeaderPill;
  glow?: AgentGlow;
  /** 程序自报的进度（0–100），只在「在跑」时有。 */
  progress?: number;
  /**
   * 推导出这些的显示结果。可省是为了让「什么都不画」的 `{}` 也是一个合法的
   * 节点头状态（启动失败时调用方直接给 `{}`）。
   */
  display?: SessionDisplay;
}

/** 通知面板里一条「需要人处理」画什么色调（与同一状态的胶囊同色）。 */
export const NEED_TONE: Record<HumanNeed, StatusTone> = {
  approval: "attention",
  input: "attention",
  error: "failed",
  handoff: "queued",
};

/**
 * 时间线工具行的状态 → tone。`timeline/view/rows/ToolRow` 原先自己写一份，
 * 状态族只认这里（设计系统 §11.1）。
 */
export const TOOL_STATUS_TONES: Record<TimelineToolStatus, StatusTone> = {
  pending: "queued",
  in_progress: "working",
  completed: "done",
  failed: "failed",
  cancelled: "paused",
};

/** 本机服务探测结果 → tone（原 `ServicePicker.STATUS_TONE`）。 */
export const SERVICE_STATUS_TONES: Record<ServiceStatus, StatusTone> = {
  online: "done",
  offline: "idle",
  unknown: "queued",
};

/** 静止的常态（空闲、已读的完成）不画胶囊：空闲不占头部空间。 */
const QUIET_TONES: ReadonlySet<StatusTone> = new Set(["idle", "done"]);

export function pillOf(display: SessionDisplay): HeaderPill | undefined {
  if (QUIET_TONES.has(display.tone)) return undefined;
  return {
    tone: display.tone,
    labelKey: display.labelKey,
    ...(display.detail !== undefined ? { detail: display.detail } : {}),
  };
}

/**
 * 光晕。出错或被打断的回合只在没人看过时才亮；看过之后留胶囊、熄光晕。
 */
export function glowOf(
  display: SessionDisplay,
  unread: boolean,
): AgentGlow | undefined {
  switch (display.tone) {
    case "attention":
      return "attention";
    case "working":
      return "working";
    case "failed":
      return unread ? "failed" : undefined;
    case "paused":
      return unread ? "unread" : undefined;
    case "unread":
      return "unread";
    default:
      return undefined;
  }
}

export function headerOf(
  display: SessionDisplay,
  unread: boolean,
): HeaderState {
  const pill = pillOf(display);
  const glow = glowOf(display, unread);
  return {
    display,
    ...(pill ? { pill } : {}),
    ...(glow ? { glow } : {}),
    ...(display.progress !== undefined ? { progress: display.progress } : {}),
  };
}

/**
 * `StatusLine` 要的那一行：阶段 · 细节 · 计时。节点头胶囊、侧栏、抽屉、活动卡
 * 都从同一个 `SessionDisplay` 来，这里只把它翻成已本地化的文案；三种形态
 * （点、胶囊、行）因此对同一个 tone 说同一句话。
 */
export interface StatusLineModel {
  tone: StatusTone;
  /** 阶段文案（已本地化）。 */
  phaseLabel: string;
  detail: string | undefined;
  /** 阶段开始的毫秒时间戳。 */
  since: number | undefined;
  /** 只有「在跑」转圈；等审批 / 出错 / 排队都不转。 */
  spinning: boolean;
}

export function lineOf(
  display: SessionDisplay,
  activity: SessionActivity | undefined,
  t: (key: string) => string,
): StatusLineModel {
  return {
    tone: display.tone,
    phaseLabel: t(display.labelKey),
    detail: display.detail,
    since: display.since ?? activity?.since,
    spinning: display.tone === "working",
  };
}

/* ---------------------------------- 输入 ---------------------------------- */

/** 会话行能喂给 `sessionDisplay` 的那几列（`agent/sessions.ts` 的 `SessionRow`）。 */
export interface DisplayRow {
  state?: string | undefined;
  stateSource?: string | undefined;
  pendingId?: string | undefined;
  errored?: boolean | undefined;
  interrupted?: boolean | undefined;
  unread: boolean;
  restored?: boolean | undefined;
  alive: boolean;
  activity?: SessionActivity | undefined;
  program?: ProgramStatus | undefined;
}

export function displayOfRow(row: DisplayRow): SessionDisplay {
  return sessionDisplay({
    status: row,
    alive: row.alive,
    unread: row.unread,
    ...(row.activity ? { activity: row.activity } : {}),
    ...(row.program ? { program: row.program } : {}),
  });
}

/** 镜像条目（可能没有）→ 显示。`program` 是程序自报，普通终端也可以有。 */
export function displayOfStatus(
  status: MirroredStatus | undefined,
  program?: ProgramStatus,
): SessionDisplay {
  return sessionDisplay({
    ...(status ? { status } : {}),
    ...(status?.alive !== undefined ? { alive: status.alive } : {}),
    ...(status?.activity ? { activity: status.activity } : {}),
    ...(program ? { program } : {}),
  });
}
