import type {
  AgentState,
  DeliveryChildSource,
  DeliveryChildrenSummary,
  DeliveryStatus,
  PullSnapshot,
  WorkItemStage,
} from "@armadra/shared";

/**
 * 四栏交付状态（Armadra#988）：由 Agent 状态、工作项阶段与 PR 快照推出的纯函数。
 * 推导顺序是产品决定，见 Issue 与设计 P3；这里不读库、不看终端输出。
 */

export interface DeliveryAgentFacts {
  readonly state: AgentState | null;
  /** `pendingId` 非空。 */
  readonly pending: boolean;
  readonly errored: boolean;
  readonly interrupted: boolean;
  readonly endedBy: "stale" | "terminated" | "modelError" | null;
}

export type DeliveryPull = Pick<
  PullSnapshot,
  "state" | "draft" | "review" | "checks" | "mergeable" | "parent" | "stale"
>;

export interface DeliveryFacts {
  readonly agent: DeliveryAgentFacts | null;
  /** `itemStage` 的结果；没有工作项为 null。 */
  readonly stage: WorkItemStage | null;
  /** 工作项因自己开的 PR 合并或关闭而结束，而没有快照时用。 */
  readonly itemResult: "merged" | "closed" | null;
  readonly pulls: readonly DeliveryPull[];
  /** 子节点事实；缺省 []。 */
  readonly children?: readonly DeliveryChildFact[];
  /** 父节点上次进入 `done` 的时刻；缺省 null。 */
  readonly idleAtMs?: number | null;
  /** 本节点的 `collect` 步骤；缺省 null。 */
  readonly collect?: "running" | "escalated" | null;
}

export interface DeliveryChildFact {
  readonly nodeId: string;
  readonly source: DeliveryChildSource;
  readonly finished: boolean;
  readonly startedAtMs: number | null;
  readonly endedAtMs: number | null;
  readonly needsYou: boolean;
}

export interface DeliveryWave extends DeliveryChildrenSummary {
  readonly nodes: readonly DeliveryChildFact[];
  /** 未结束、来源为 task / workflow 的子任务数。 */
  readonly unfinishedOwned: number;
  /** 未结束、只有连线来源的子节点数。 */
  readonly unfinishedEdges: number;
}

/**
 * 「这一批」子任务（设计 §1.3）：有未结束的子任务时以它们为种子，否则以结束时刻
 * 不早于 `idleAtMs` 的已结束子任务为种子，再按开始时刻向前扩张到时间区间连通。
 */
export function deliveryWave(facts: DeliveryFacts): DeliveryWave | null {
  const all = facts.children ?? [];
  const idleAt = facts.idleAtMs ?? null;
  const unfinished = all.filter((child) => !child.finished);
  const ended = all.filter((child) => child.finished);
  const wave = new Set<DeliveryChildFact>(
    unfinished.length > 0
      ? unfinished
      : ended.filter(
          (child) =>
            idleAt === null ||
            (child.endedAtMs !== null && child.endedAtMs >= idleAt),
        ),
  );
  if (wave.size === 0) return null;

  for (;;) {
    const starts = [...wave]
      .map((child) => child.startedAtMs)
      .filter((value): value is number => value !== null);
    if (starts.length === 0) break;
    const earliest = Math.min(...starts);
    const grown = ended.filter(
      (child) =>
        !wave.has(child) &&
        child.endedAtMs !== null &&
        child.endedAtMs >= earliest,
    );
    if (grown.length === 0) break;
    for (const child of grown) wave.add(child);
  }

  const members = [...wave];
  const open = members.filter((child) => !child.finished);
  const nodes = [
    ...open,
    ...members
      .filter((child) => child.finished)
      .sort((a, b) => (b.endedAtMs ?? 0) - (a.endedAtMs ?? 0)),
  ];
  return {
    total: members.length,
    finished: members.length - open.length,
    needsYou: members.filter((child) => child.needsYou).length,
    nodes,
    unfinishedOwned: open.filter((child) => child.source !== "edge").length,
    unfinishedEdges: open.filter((child) => child.source === "edge").length,
  };
}

function offBoard(facts: DeliveryFacts): DeliveryStatus | undefined {
  // 节点已经开始下一回合：终态的 PR 当作不存在，按后面的步骤走（D7）。
  if (facts.agent?.state === "working") return undefined;
  if (facts.pulls.length === 0) {
    return facts.itemResult === null
      ? undefined
      : { lane: "offBoard", phrase: facts.itemResult };
  }
  if (facts.pulls.some((pull) => pull.state === "open")) return undefined;
  return {
    lane: "offBoard",
    phrase: facts.pulls.some((pull) => pull.state === "merged")
      ? "merged"
      : "closed",
  };
}

function needsYou(facts: DeliveryFacts): DeliveryStatus | undefined {
  const { agent, stage } = facts;
  const phrase = (
    value: Extract<DeliveryStatus, { lane: "needsYou" }>["phrase"],
  ) => ({ lane: "needsYou", phrase: value }) as const;
  if (agent?.pending === true || agent?.state === "blocked") {
    return phrase("needsApproval");
  }
  if (stage === "person/answer" || agent?.state === "waiting") {
    return phrase("needsAnswer");
  }
  if (stage === "person/delivery") return phrase("deliveryFailed");
  if (stage === "person/review") return phrase("readyForReview");
  if (stage === "person/blocked") return phrase("blocked");
  if (agent?.endedBy === "terminated") return phrase("exited");
  if (agent?.endedBy === "stale") return phrase("noSignal");
  if (stage === "person/failed" || agent?.errored === true) {
    return phrase("failed");
  }
  if (agent?.interrupted === true) return phrase("interrupted");
  return undefined;
}

const PROBLEMS = ["ci", "conflict", "changes"] as const;
type Problem = (typeof PROBLEMS)[number];

function problemOf(pull: DeliveryPull): Problem | undefined {
  if (pull.checks.read && pull.checks.rollup === "failure") return "ci";
  if (pull.mergeable === "conflicting") return "conflict";
  if (pull.review === "changesRequested") return "changes";
  return undefined;
}

function isReady(pull: DeliveryPull): boolean {
  return (
    (pull.review === "approved" || pull.review === "notRequired") &&
    pull.checks.read &&
    (pull.checks.rollup === "success" ||
      pull.checks.rollup === "neutral" ||
      pull.checks.rollup === "none") &&
    pull.mergeable === "mergeable" &&
    pull.parent.kind === "none" &&
    !pull.stale
  );
}

const REVIEW_PHRASES = [
  "waitingOnBase",
  "checksRunning",
  "awaitingReview",
  "mergeabilityUnknown",
] as const;

function reviewPhrase(pull: DeliveryPull): (typeof REVIEW_PHRASES)[number] {
  if (pull.parent.kind === "open") return "waitingOnBase";
  if (!pull.checks.read || pull.checks.rollup === "pending") {
    return "checksRunning";
  }
  if (pull.review === "reviewRequired" || pull.review === "unknown") {
    return "awaitingReview";
  }
  return "mergeabilityUnknown";
}

/** 一个 open 且非草稿的 PR：落后程度（越小越落后）与同档内的次序。 */
interface Placed {
  readonly rank: 1 | 2 | 3;
  readonly sub: number;
  readonly status: (agentWorking: boolean) => DeliveryStatus;
}

function place(pull: DeliveryPull): Placed {
  const problem = problemOf(pull);
  if (problem !== undefined) {
    return {
      rank: 1,
      sub: PROBLEMS.indexOf(problem),
      status: (working) => {
        if (working) {
          return {
            lane: "working",
            phrase: {
              ci: "fixingCi",
              conflict: "resolvingConflicts",
              changes: "addressingReview",
            }[problem],
          } as DeliveryStatus;
        }
        return {
          lane: "needsYou",
          phrase: {
            ci: "ciFailing",
            conflict: "mergeConflicts",
            changes: "changesRequested",
          }[problem],
        } as DeliveryStatus;
      },
    };
  }
  if (isReady(pull)) {
    const phrase = pull.review === "approved" ? "approved" : "mergeable";
    return {
      rank: 3,
      sub: 0,
      status: () => ({ lane: "readyToMerge", phrase }),
    };
  }
  const phrase = reviewPhrase(pull);
  return {
    rank: 2,
    sub: REVIEW_PHRASES.indexOf(phrase),
    status: () => ({ lane: "inReview", phrase }),
  };
}

export function deliveryStatus(facts: DeliveryFacts): DeliveryStatus {
  const wave = deliveryWave(facts);
  const owned = wave?.unfinishedOwned ?? 0;
  const edges = wave?.unfinishedEdges ?? 0;
  const collect = facts.collect ?? null;
  const working = facts.agent?.state === "working";

  // 还有未结束的子任务或在汇总时，PR 已结束也不离开看板。
  if (owned === 0 && collect !== "running") {
    const gone = offBoard(facts);
    if (gone !== undefined) return gone;
  }

  const human = needsYou(facts);
  if (human !== undefined) return human;
  if (collect === "escalated") return { lane: "needsYou", phrase: "blocked" };
  if (owned > 0) return { lane: "working", phrase: "waitingOnChildren" };
  if (collect === "running" || (working && edges === 0 && wave !== null)) {
    return { lane: "working", phrase: "collecting" };
  }

  const open = facts.pulls.filter((pull) => pull.state === "open");
  const hasDraft = open.some((pull) => pull.draft);
  if (open.length === 0 || hasDraft) {
    if (facts.stage === "working/queued") {
      return { lane: "working", phrase: "queued" };
    }
    if (working) return { lane: "working", phrase: "working" };
    if (edges > 0) return { lane: "working", phrase: "waitingOnChildren" };
    if (hasDraft) return { lane: "working", phrase: "draft" };
    return { lane: "working", phrase: "idle" };
  }

  const worst = open
    .map(place)
    .reduce((a, b) =>
      b.rank < a.rank || (b.rank === a.rank && b.sub < a.sub) ? b : a,
    );
  return worst.status(working);
}
