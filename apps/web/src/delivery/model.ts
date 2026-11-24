import {
  DELIVERY_PHRASES,
  type DeliveryLane,
  type DeliveryPull,
} from "@armadra/shared";

import type { StatusTone } from "@/ui/status-pill";

/**
 * 交付看板的静态表（Armadra#988 P4）：栏的顺序、栏与短语到状态胶囊色调的映射、
 * i18n 键。纯数据，面板与节点头共用。
 */

/** 看板上的四栏，从左到右。`offBoard` 不在其中，它进底部的收起区。 */
export const BOARD_LANES = [
  "needsYou",
  "working",
  "inReview",
  "readyToMerge",
] as const;
export type BoardLane = (typeof BOARD_LANES)[number];

/** 节点头只在这三栏上画标记：进行中已经有 Agent 状态胶囊。 */
export const BADGE_LANES: readonly DeliveryLane[] = [
  "needsYou",
  "inReview",
  "readyToMerge",
];

export const laneKey = (lane: DeliveryLane): string => `delivery.lane.${lane}`;

/** 终态短语（merged / closed）用 `delivery.offBoard.*`，其余用 `delivery.phrase.*`。 */
export function phraseKey(lane: DeliveryLane, phrase: string): string {
  return lane === "offBoard"
    ? `delivery.offBoard.${phrase}`
    : `delivery.phrase.${phrase}`;
}

export const OFF_BOARD_PHRASES = DELIVERY_PHRASES.offBoard;

/** 全部短语 → 色调。键按栏分组，`model.test` 校验与 shared 的短语表一一对应。 */
export const PHRASE_TONE: Record<string, StatusTone> = {
  // working
  working: "working",
  queued: "queued",
  fixingCi: "working",
  addressingReview: "working",
  resolvingConflicts: "working",
  draft: "idle",
  idle: "idle",
  // needsYou
  needsApproval: "attention",
  needsAnswer: "attention",
  readyForReview: "attention",
  blocked: "attention",
  failed: "failed",
  deliveryFailed: "failed",
  interrupted: "paused",
  exited: "paused",
  noSignal: "paused",
  ciFailing: "failed",
  mergeConflicts: "failed",
  changesRequested: "attention",
  // inReview
  awaitingReview: "queued",
  checksRunning: "working",
  waitingOnBase: "queued",
  mergeabilityUnknown: "paused",
  // readyToMerge
  mergeable: "done",
  approved: "done",
  // offBoard
  merged: "done",
  closed: "idle",
};

export function phraseTone(phrase: string): StatusTone {
  return PHRASE_TONE[phrase] ?? "idle";
}

/**
 * 一个 PR 离「可合并」有多远，数字越小越落后。多个 PR 时最落后的排前
 * （设计「边界」：最落后的一个说话）。
 */
export function pullRank(pull: DeliveryPull): number {
  if (pull.state !== "open") return 7;
  if (pull.mergeable === "conflicting") return 0;
  if (pull.checks.read && pull.checks.rollup === "failure") return 1;
  if (pull.review === "changesRequested") return 2;
  if (pull.draft) return 3;
  if (pull.checks.read && pull.checks.rollup === "pending") return 4;
  if (pull.review === "reviewRequired" || pull.review === "unknown") return 5;
  return 6;
}

/** 最落后的在前；同一档按 PR 编号。不改原数组。 */
export function sortPulls(pulls: readonly DeliveryPull[]): DeliveryPull[] {
  return [...pulls].sort(
    (a, b) => pullRank(a) - pullRank(b) || a.number - b.number,
  );
}

/** 移出看板的条目保留多久（设计 D7）：24 小时，或到节点开始下一回合。 */
export const OFF_BOARD_KEEP_MS = 24 * 60 * 60 * 1000;
