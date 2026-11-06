import type { IntakeCandidate } from "./intake";
import type { SourceView } from "./service";

/**
 * 页面看到的来源与候选（契约 §104.7，`coordinator.sources` / `coordinator.intake`）。
 * 候选不带正文、请求人与规则哈希：页面只要标题、作者、链接、判定与结果；时刻是
 * RFC 3339，与任务行一致。
 */

const iso = (ms: number): string => new Date(ms).toISOString();

export function sourceJson(view: SourceView): Record<string, unknown> {
  const { source } = view;
  return {
    id: source.id,
    coordinatorNodeId: source.coordinatorNodeId,
    repo: source.repo,
    kinds: [...source.kinds],
    mode: source.mode,
    allow: [...source.allow],
    enabled: source.enabled,
    rulesHash: source.rulesHash,
    rulesCurrentHash: view.rulesCurrentHash,
    rulesPresent: view.rulesPresent,
    stats: view.stats,
  };
}

export function candidateJson(
  candidate: IntakeCandidate,
): Record<string, unknown> {
  return {
    id: candidate.id,
    sourceId: candidate.sourceId,
    kind: candidate.kind,
    repo: candidate.repo,
    number: candidate.number,
    title: candidate.title,
    author: candidate.author,
    url: candidate.url,
    authorized: candidate.authorized,
    seenAt: iso(candidate.seenAt),
    verdict: candidate.verdict,
    reason: candidate.verdictReason,
    verdictAt: candidate.verdictAt === null ? null : iso(candidate.verdictAt),
    modeAtVerdict: candidate.modeAtVerdict,
    review: candidate.review,
    itemId: candidate.itemId,
    outcome: candidate.outcome,
  };
}
