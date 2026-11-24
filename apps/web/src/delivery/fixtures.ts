import type { DeliveryNode } from "@armadra/shared";

type Pull = DeliveryNode["pulls"][number];

/** 测试夹具：一个 PR 与一个节点，字段按需覆盖。 */
export function pull(patch: Partial<Pull> = {}): Pull {
  return {
    repo: "acme/app",
    number: 1,
    url: "https://github.com/acme/app/pull/1",
    title: "Add feature",
    state: "open",
    draft: false,
    baseRef: "main",
    headRef: "feat/x",
    headSha: "abc",
    fromFork: false,
    review: "reviewRequired",
    checks: { read: true, headSha: "abc", rollup: "success", failing: [] },
    mergeable: "mergeable",
    parent: { kind: "none" },
    fetchedAtMs: 1_000,
    stale: false,
    ...patch,
  };
}

export function node(patch: Partial<DeliveryNode> = {}): DeliveryNode {
  return {
    nodeId: "n1",
    taskId: null,
    lane: "inReview",
    phrase: "awaitingReview",
    pulls: [],
    ...patch,
  };
}

/** 测试夹具：带子任务计数与列表的节点。 */
export function withChildren(
  total: number,
  finished: number,
  needsYou = 0,
  ids: readonly string[] = [],
): Pick<DeliveryNode, "children"> {
  return {
    children: {
      total,
      finished,
      needsYou,
      nodes: ids.map((nodeId) => ({
        nodeId,
        source: "task" as const,
        finished: false,
      })),
    },
  };
}
