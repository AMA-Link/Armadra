/**
 * 进展看门狗的标记（契约 §91）：节点上的「停滞 / 空等 / 等人太久」。
 *
 * 标记只活在内存里（看门狗在 `workflow/progress-watchdog.ts`），这里是它的出口：
 * `agent.status` 帧与会话列表在发出前经 {@link withStalled} 附上标记。标记绑定
 * 判定当时的状态指纹（状态 + 最后一次上报时刻）：节点有了新的上报，指纹就对不上，
 * 帧上不再带标记，页面随下一帧清掉它，不必等看门狗下一次扫描。
 */

import type { AgentStallKind } from "@armadra/shared";

export type StallKind = AgentStallKind;

export interface StallSource {
  /** 这行状态上有没有标记；指纹对不上就是没有。 */
  stalledOf(status: StallSubject): StallKind | undefined;
}

/** 看门狗判定与比对用到的那几个字段。 */
export interface StallSubject {
  readonly nodeId: string;
  readonly state?: string | undefined;
  readonly lastEventAt?: string | undefined;
}

/** 状态指纹：状态或最后一次上报变了，旧判定就作废。 */
export function stallBasis(subject: Omit<StallSubject, "nodeId">): string {
  return `${subject.state ?? ""}|${subject.lastEventAt ?? ""}`;
}

let source: StallSource | undefined;

export function setStallSource(next: StallSource | undefined): void {
  source = next;
}

export function stalledOf(subject: StallSubject): StallKind | undefined {
  return source?.stalledOf(subject);
}

/** 附上标记（有就带，没有原样返回）。 */
export function withStalled<T extends StallSubject>(
  status: T,
): T & { readonly stalled?: StallKind } {
  const stalled = stalledOf(status);
  return stalled === undefined ? status : { ...status, stalled };
}
