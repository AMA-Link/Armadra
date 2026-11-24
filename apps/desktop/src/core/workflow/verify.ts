import type { StepVerdict } from "./store";
import type { CollectStep, StepStatus, WorkflowStepKind } from "./types";

export interface VerifyStepView {
  readonly stepId: string;
  readonly kind: WorkflowStepKind;
  readonly status: StepStatus;
  readonly role: string | null;
  readonly after: readonly string[];
}

export type VerifyDecision =
  | { readonly kind: "done" }
  | {
      readonly kind: "retry";
      readonly reopen: readonly {
        readonly stepId: string;
        readonly issues: readonly string[];
      }[];
    }
  | {
      readonly kind: "escalate";
      readonly reason: "verifyFailed" | "verdictMissing";
    };

const DEFAULT_MAX_RETRIES = 2;

/**
 * collect 验证结论的判定（#996 §2.6）。`round` 从 0 起，与 ama 的 attempt = round + 1 对齐。
 */
export function verifyDecision(input: {
  readonly step: CollectStep;
  readonly round: number;
  readonly verdict: StepVerdict | null;
  readonly steps: readonly VerifyStepView[];
}): VerifyDecision {
  const { step, round, verdict, steps } = input;
  if (!step.verify) return { kind: "done" };
  if (!verdict || verdict.round !== round) {
    return { kind: "escalate", reason: "verdictMissing" };
  }
  if (verdict.pass) return { kind: "done" };
  if (round >= (step.maxRetries ?? DEFAULT_MAX_RETRIES)) {
    return { kind: "escalate", reason: "verifyFailed" };
  }
  const escalate: VerifyDecision = { kind: "escalate", reason: "verifyFailed" };

  const views = new Map(steps.map((view) => [view.stepId, view]));
  const fromViews = step.from.map((id) => views.get(id));
  const rolePool = fromViews.filter(
    (view): view is VerifyStepView => view !== undefined && view.role !== null,
  );
  const unrolled = verdict.issues.some((issue) => issue.role === null);

  const targets = new Set<string>();
  if (unrolled || verdict.issues.length === 0) {
    for (const view of rolePool) targets.add(view.stepId);
  }
  for (const issue of verdict.issues) {
    if (issue.role === null) continue;
    const owned = rolePool.filter((view) => view.role === issue.role);
    if (owned.length === 0) return escalate;
    for (const view of owned) targets.add(view.stepId);
  }
  if (targets.size === 0) return escalate;

  const reopen: { stepId: string; issues: string[] }[] = [];
  for (const view of rolePool) {
    if (!targets.has(view.stepId)) continue;
    const reopenable =
      (view.kind === "prompt" || view.kind === "collect") &&
      view.status === "done" &&
      steps.every(
        (other) =>
          other.stepId === step.id ||
          !other.after.includes(view.stepId) ||
          other.status === "pending",
      );
    if (!reopenable) return escalate;
    reopen.push({
      stepId: view.stepId,
      issues: verdict.issues
        .filter((issue) => issue.role === null || issue.role === view.role)
        .map((issue) => issue.text),
    });
  }
  return { kind: "retry", reopen };
}
