import {
  DELIVERY_PHRASES,
  type DeliveryStatus,
  type WorkItemStage,
} from "@armadra/shared";
import { describe, expect, it } from "vitest";

import {
  type DeliveryAgentFacts,
  type DeliveryFacts,
  type DeliveryPull,
  deliveryStatus,
} from "./delivery";

function read(rollup: "pending" | "success" | "failure" | "neutral" | "none") {
  return { read: true, headSha: "sha", rollup, failing: [] } as const;
}

const AGENT: DeliveryAgentFacts = {
  state: "done",
  pending: false,
  errored: false,
  interrupted: false,
  endedBy: null,
};

/** 默认：open、无需评审、检查通过、可合并、无父 PR、新鲜。 */
function pull(over: Partial<DeliveryPull> = {}): DeliveryPull {
  return {
    state: "open",
    draft: false,
    review: "notRequired",
    checks: read("success"),
    mergeable: "mergeable",
    parent: { kind: "none" },
    stale: false,
    ...over,
  };
}

interface Case {
  readonly name: string;
  readonly agent?: Partial<DeliveryAgentFacts> | null;
  readonly stage?: WorkItemStage | null;
  readonly itemResult?: "merged" | "closed" | null;
  readonly pulls?: readonly Partial<DeliveryPull>[];
  readonly expect: DeliveryStatus;
}

function build(c: Case): DeliveryFacts {
  return {
    agent: c.agent === null ? null : { ...AGENT, ...c.agent },
    stage: c.stage ?? null,
    itemResult: c.itemResult ?? null,
    pulls: (c.pulls ?? []).map((p) => pull(p)),
  };
}

const ok = { checks: read("success") } as const;
const failing = { checks: read("failure") } as const;
const pending = { checks: read("pending") } as const;

const CASES: readonly Case[] = [
  // 第 1 步：离开看板
  {
    name: "1 merged 优先于 agent 的审批",
    agent: { state: "blocked", pending: true },
    pulls: [{ state: "merged" }],
    expect: { lane: "offBoard", phrase: "merged" },
  },
  {
    name: "1 反例：merged 而 agent 在干活，终态的 PR 当作不存在",
    agent: { state: "working" },
    pulls: [{ state: "merged" }],
    expect: { lane: "working", phrase: "working" },
  },
  {
    name: "1 反例：closed 而 agent 在干活",
    agent: { state: "working" },
    pulls: [{ state: "closed" }],
    expect: { lane: "working", phrase: "working" },
  },
  {
    name: "1 反例：merged 加 agent 在干活，另有 open 的 PR 按它算",
    agent: { state: "working" },
    pulls: [{ state: "merged" }, { review: "reviewRequired" }],
    expect: { lane: "inReview", phrase: "awaitingReview" },
  },
  {
    name: "1 反例：itemResult 有值而 agent 在干活",
    agent: { state: "working" },
    itemResult: "merged",
    expect: { lane: "working", phrase: "working" },
  },
  {
    name: "1 merged 而 agent 已 done 仍离开看板",
    agent: { state: "done" },
    pulls: [{ state: "merged" }],
    expect: { lane: "offBoard", phrase: "merged" },
  },
  {
    name: "1 全部 closed",
    pulls: [{ state: "closed" }, { state: "closed" }],
    expect: { lane: "offBoard", phrase: "closed" },
  },
  {
    name: "1 merged 与 closed 并存取 merged",
    pulls: [{ state: "closed" }, { state: "merged" }],
    expect: { lane: "offBoard", phrase: "merged" },
  },
  {
    name: "1 没有快照时按 itemResult",
    itemResult: "closed",
    agent: { state: "waiting" },
    expect: { lane: "offBoard", phrase: "closed" },
  },
  {
    name: "1 反例：还有 open 的 PR 就不离开看板",
    pulls: [{ state: "merged" }, {}],
    expect: { lane: "readyToMerge", phrase: "mergeable" },
  },
  {
    name: "1 部分已合并的 PR 被忽略",
    pulls: [{ state: "merged" }, { ...ok, review: "reviewRequired" }],
    expect: { lane: "inReview", phrase: "awaitingReview" },
  },

  // 第 2 步：需要人，每个短语一条
  {
    name: "2 needsApproval：pendingId",
    agent: { pending: true },
    expect: { lane: "needsYou", phrase: "needsApproval" },
  },
  {
    name: "2 needsApproval：state blocked",
    agent: { state: "blocked" },
    expect: { lane: "needsYou", phrase: "needsApproval" },
  },
  {
    name: "2 needsAnswer：person/answer",
    stage: "person/answer",
    expect: { lane: "needsYou", phrase: "needsAnswer" },
  },
  {
    name: "2 needsAnswer：state waiting",
    agent: { state: "waiting" },
    expect: { lane: "needsYou", phrase: "needsAnswer" },
  },
  {
    name: "2 deliveryFailed",
    stage: "person/delivery",
    expect: { lane: "needsYou", phrase: "deliveryFailed" },
  },
  {
    name: "2 readyForReview",
    stage: "person/review",
    expect: { lane: "needsYou", phrase: "readyForReview" },
  },
  {
    name: "2 blocked",
    stage: "person/blocked",
    expect: { lane: "needsYou", phrase: "blocked" },
  },
  {
    name: "2 exited：endedBy terminated",
    agent: { endedBy: "terminated" },
    expect: { lane: "needsYou", phrase: "exited" },
  },
  {
    name: "2 noSignal：endedBy stale",
    agent: { endedBy: "stale" },
    expect: { lane: "needsYou", phrase: "noSignal" },
  },
  {
    name: "2 failed：endedBy modelError 且 errored",
    agent: { endedBy: "modelError", errored: true },
    expect: { lane: "needsYou", phrase: "failed" },
  },
  {
    name: "2 failed：person/failed",
    stage: "person/failed",
    expect: { lane: "needsYou", phrase: "failed" },
  },
  {
    name: "2 failed：errored",
    agent: { errored: true },
    expect: { lane: "needsYou", phrase: "failed" },
  },
  {
    name: "2 interrupted",
    agent: { interrupted: true },
    expect: { lane: "needsYou", phrase: "interrupted" },
  },
  // 第 2 步内部次序
  {
    name: "2 审批先于提问",
    agent: { pending: true, state: "waiting" },
    stage: "person/answer",
    expect: { lane: "needsYou", phrase: "needsApproval" },
  },
  {
    name: "2 提问先于投递失败",
    stage: "person/answer",
    agent: { state: "waiting" },
    expect: { lane: "needsYou", phrase: "needsAnswer" },
  },
  {
    name: "2 terminated 先于 failed",
    agent: { endedBy: "terminated", errored: true },
    stage: "person/failed",
    expect: { lane: "needsYou", phrase: "exited" },
  },
  {
    name: "2 stale 先于 interrupted",
    agent: { endedBy: "stale", interrupted: true },
    expect: { lane: "needsYou", phrase: "noSignal" },
  },
  {
    name: "2 failed 先于 interrupted",
    agent: { errored: true, interrupted: true },
    expect: { lane: "needsYou", phrase: "failed" },
  },
  // 第 2 步先于 PR 的判定
  {
    name: "2 需要人先于可合并的 PR",
    agent: { state: "waiting" },
    pulls: [{ review: "approved" }],
    expect: { lane: "needsYou", phrase: "needsAnswer" },
  },
  {
    name: "2 需要人先于 CI 失败的 PR",
    stage: "person/review",
    pulls: [failing],
    expect: { lane: "needsYou", phrase: "readyForReview" },
  },

  // 第 3 步：没有 open PR 或有草稿
  {
    name: "3 queued",
    stage: "working/queued",
    expect: { lane: "working", phrase: "queued" },
  },
  {
    name: "3 working",
    agent: { state: "working" },
    expect: { lane: "working", phrase: "working" },
  },
  {
    name: "3 draft",
    pulls: [{ draft: true }],
    expect: { lane: "working", phrase: "draft" },
  },
  {
    name: "3 idle：没有 PR 也没有活动",
    agent: { state: "done" },
    expect: { lane: "working", phrase: "idle" },
  },
  {
    name: "3 idle：没有任何 Agent 信息",
    agent: null,
    expect: { lane: "working", phrase: "idle" },
  },
  {
    name: "3 draft 加 agent working 取 working",
    agent: { state: "working" },
    pulls: [{ draft: true }],
    expect: { lane: "working", phrase: "working" },
  },
  {
    name: "3 queued 先于 working",
    stage: "working/queued",
    agent: { state: "working" },
    pulls: [{ draft: true }],
    expect: { lane: "working", phrase: "queued" },
  },
  {
    name: "3 草稿是最落后的：与可合并的 PR 并存仍在 working",
    pulls: [{}, { draft: true }],
    expect: { lane: "working", phrase: "draft" },
  },
  {
    name: "3 草稿即使 CI 失败也在 working",
    pulls: [{ draft: true, ...failing }],
    expect: { lane: "working", phrase: "draft" },
  },

  // 第 4 步：有问题
  {
    name: "4 CI 失败，agent 不在干活",
    pulls: [failing],
    expect: { lane: "needsYou", phrase: "ciFailing" },
  },
  {
    name: "4 冲突",
    pulls: [{ mergeable: "conflicting" }],
    expect: { lane: "needsYou", phrase: "mergeConflicts" },
  },
  {
    name: "4 要求修改",
    pulls: [{ review: "changesRequested" }],
    expect: { lane: "needsYou", phrase: "changesRequested" },
  },
  {
    name: "4 CI 失败而 agent 在干活",
    agent: { state: "working" },
    pulls: [failing],
    expect: { lane: "working", phrase: "fixingCi" },
  },
  {
    name: "4 冲突而 agent 在干活",
    agent: { state: "working" },
    pulls: [{ mergeable: "conflicting" }],
    expect: { lane: "working", phrase: "resolvingConflicts" },
  },
  {
    name: "4 要求修改而 agent 在干活",
    agent: { state: "working" },
    pulls: [{ review: "changesRequested" }],
    expect: { lane: "working", phrase: "addressingReview" },
  },
  {
    name: "4 优先级：CI 先于冲突先于要求修改",
    pulls: [
      { mergeable: "conflicting", review: "changesRequested", ...failing },
    ],
    expect: { lane: "needsYou", phrase: "ciFailing" },
  },
  {
    name: "4 优先级：冲突先于要求修改",
    pulls: [{ mergeable: "conflicting", review: "changesRequested" }],
    expect: { lane: "needsYou", phrase: "mergeConflicts" },
  },
  {
    name: "4 反例：未读到检查不算 CI 失败",
    pulls: [{ checks: { read: false } }],
    expect: { lane: "inReview", phrase: "checksRunning" },
  },
  {
    name: "4 stale 的快照照常判定问题",
    pulls: [{ stale: true, ...failing }],
    expect: { lane: "needsYou", phrase: "ciFailing" },
  },
  {
    name: "4 有问题的 PR 排在审查中的 PR 前",
    pulls: [{ review: "reviewRequired", ...ok }, failing],
    expect: { lane: "needsYou", phrase: "ciFailing" },
  },
  {
    name: "4 多个问题 PR 之间按优先级",
    pulls: [{ review: "changesRequested" }, { mergeable: "conflicting" }],
    expect: { lane: "needsYou", phrase: "mergeConflicts" },
  },

  // 第 5 步：可合并
  {
    name: "5 approved",
    pulls: [{ review: "approved" }],
    expect: { lane: "readyToMerge", phrase: "approved" },
  },
  {
    name: "5 mergeable：无需评审",
    pulls: [{ review: "notRequired" }],
    expect: { lane: "readyToMerge", phrase: "mergeable" },
  },
  {
    name: "5 neutral 算通过",
    pulls: [{ checks: read("neutral") }],
    expect: { lane: "readyToMerge", phrase: "mergeable" },
  },
  {
    name: "5 none 且已读算通过",
    pulls: [{ checks: read("none") }],
    expect: { lane: "readyToMerge", phrase: "mergeable" },
  },
  {
    name: "5 none 但未读不算通过",
    pulls: [{ checks: { read: false } }],
    expect: { lane: "inReview", phrase: "checksRunning" },
  },
  {
    name: "5 review unknown 不等于 notRequired",
    pulls: [{ review: "unknown" }],
    expect: { lane: "inReview", phrase: "awaitingReview" },
  },
  {
    name: "5 mergeable unknown 不算可合并",
    pulls: [{ mergeable: "unknown" }],
    expect: { lane: "inReview", phrase: "mergeabilityUnknown" },
  },
  {
    name: "5 stale 的快照不判可合并",
    pulls: [{ stale: true, review: "approved" }],
    expect: { lane: "inReview", phrase: "mergeabilityUnknown" },
  },
  {
    name: "5 父 PR 为 unknown 不算可合并",
    pulls: [{ parent: { kind: "unknown" } }],
    expect: { lane: "inReview", phrase: "mergeabilityUnknown" },
  },
  {
    name: "5 多个 PR 取最落后：审查中的 PR 拖住可合并的",
    pulls: [{ review: "approved" }, { review: "reviewRequired" }],
    expect: { lane: "inReview", phrase: "awaitingReview" },
  },
  {
    name: "5 多个 PR 都可合并，有 approved 的也有 mergeable 的取先到者的最落后",
    pulls: [{ review: "approved" }, { review: "notRequired" }],
    expect: { lane: "readyToMerge", phrase: "approved" },
  },

  // 第 6 步：审查中，短语次序
  {
    name: "6 waitingOnBase 先于其余",
    pulls: [
      {
        parent: { kind: "open", number: 1, url: "u" },
        review: "reviewRequired",
        ...pending,
      },
    ],
    expect: { lane: "inReview", phrase: "waitingOnBase" },
  },
  {
    name: "6 checksRunning：pending",
    pulls: [{ ...pending, review: "reviewRequired" }],
    expect: { lane: "inReview", phrase: "checksRunning" },
  },
  {
    name: "6 awaitingReview：reviewRequired",
    pulls: [{ review: "reviewRequired" }],
    expect: { lane: "inReview", phrase: "awaitingReview" },
  },
  {
    name: "6 mergeabilityUnknown：其余",
    pulls: [{ mergeable: "unknown", review: "approved" }],
    expect: { lane: "inReview", phrase: "mergeabilityUnknown" },
  },
  {
    name: "6 反例：审查中的 PR 里 pending 在多个 PR 间取次序靠前者",
    pulls: [{ review: "reviewRequired" }, { ...pending }],
    expect: { lane: "inReview", phrase: "checksRunning" },
  },
];

describe("deliveryStatus", () => {
  it.each(CASES)("$name", (c) => {
    expect(deliveryStatus(build(c))).toEqual(c.expect);
  });

  it("every phrase of every lane is reachable from some case", () => {
    const seen = new Set(
      CASES.map((c) => `${c.expect.lane}/${c.expect.phrase}`),
    );
    for (const [lane, phrases] of Object.entries(DELIVERY_PHRASES)) {
      for (const phrase of phrases) {
        expect(seen.has(`${lane}/${phrase}`), `${lane}/${phrase}`).toBe(true);
      }
    }
  });
});
