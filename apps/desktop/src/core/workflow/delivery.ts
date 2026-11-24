import type {
  AgentState,
  DeliveryStatus,
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

// TODO(#988): P1 合并后改为 `Pick<PullSnapshot, "state" | "draft" | "review"
// | "checks" | "mergeable" | "parent" | "stale">`，字段与 P1 冻结定义一致。
export interface DeliveryPull {
  readonly state: "open" | "merged" | "closed";
  readonly draft: boolean;
  readonly review:
    | "approved"
    | "changesRequested"
    | "reviewRequired"
    | "notRequired"
    | "unknown";
  readonly checks:
    | {
        readonly read: true;
        readonly rollup: "pending" | "success" | "failure" | "neutral" | "none";
      }
    | { readonly read: false };
  readonly mergeable: "mergeable" | "conflicting" | "unknown";
  readonly parent:
    | { readonly kind: "none" }
    | { readonly kind: "open" }
    | { readonly kind: "unknown" };
  readonly stale: boolean;
}

export interface DeliveryFacts {
  readonly agent: DeliveryAgentFacts | null;
  /** `itemStage` 的结果；没有工作项为 null。 */
  readonly stage: WorkItemStage | null;
  /** 工作项因自己开的 PR 合并或关闭而结束，而没有快照时用。 */
  readonly itemResult: "merged" | "closed" | null;
  readonly pulls: readonly DeliveryPull[];
}

function offBoard(facts: DeliveryFacts): DeliveryStatus | undefined {
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
  const gone = offBoard(facts);
  if (gone !== undefined) return gone;

  const human = needsYou(facts);
  if (human !== undefined) return human;

  const open = facts.pulls.filter((pull) => pull.state === "open");
  const hasDraft = open.some((pull) => pull.draft);
  const working = facts.agent?.state === "working";
  if (open.length === 0 || hasDraft) {
    if (facts.stage === "working/queued") {
      return { lane: "working", phrase: "queued" };
    }
    if (working) return { lane: "working", phrase: "working" };
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
