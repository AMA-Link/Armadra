import { describe, expect, it } from "vitest";
import type { CollectStep } from "./types";
import {
  verifyDecision,
  type VerifyStepView,
  type VerifyVerdict,
} from "./verify";

const verify = { commands: ["pnpm test"], checklist: [] };
const collect = (over: Partial<CollectStep> = {}): CollectStep => ({
  id: "c",
  kind: "collect",
  role: "lead",
  from: ["a", "b"],
  prompt: "x",
  after: ["a", "b"],
  verify,
  ...over,
});
const view = (
  stepId: string,
  role: string | null,
  over: Partial<VerifyStepView> = {},
): VerifyStepView => ({
  stepId,
  kind: "prompt",
  status: "done",
  role,
  after: [],
  ...over,
});
const baseSteps = (): VerifyStepView[] => [
  view("a", "dev"),
  view("b", "ui"),
  view("c", "lead", { kind: "collect", status: "running", after: ["a", "b"] }),
];
const fail = (
  issues: VerifyVerdict["issues"],
  round = 0,
): VerifyVerdict => ({ round, pass: false, issues, at: 1 });

interface Case {
  name: string;
  step?: CollectStep;
  round?: number;
  verdict: VerifyVerdict | null;
  steps?: VerifyStepView[];
  expected: ReturnType<typeof verifyDecision>;
}

const CASES: Case[] = [
  {
    name: "1 没有 verify -> done",
    step: collect({ verify: null }),
    verdict: null,
    expected: { kind: "done" },
  },
  {
    name: "2 未报结论 -> verdictMissing",
    verdict: null,
    expected: { kind: "escalate", reason: "verdictMissing" },
  },
  {
    name: "2 结论是上一轮的 -> verdictMissing",
    round: 1,
    verdict: { round: 0, pass: true, issues: [], at: 1 },
    expected: { kind: "escalate", reason: "verdictMissing" },
  },
  {
    name: "3 通过 -> done",
    verdict: { round: 0, pass: true, issues: [], at: 1 },
    expected: { kind: "done" },
  },
  {
    name: "4 用尽（缺省 2）-> verifyFailed",
    round: 2,
    verdict: fail([{ role: "dev", text: "t" }], 2),
    expected: { kind: "escalate", reason: "verifyFailed" },
  },
  {
    name: "4 maxRetries=0 第一轮失败即升级",
    step: collect({ maxRetries: 0 }),
    verdict: fail([{ role: "dev", text: "t" }]),
    expected: { kind: "escalate", reason: "verifyFailed" },
  },
  {
    name: "4 maxRetries=3 第 2 轮仍可退回",
    step: collect({ maxRetries: 3 }),
    round: 2,
    verdict: fail([{ role: "dev", text: "t" }], 2),
    expected: { kind: "retry", reopen: [{ stepId: "a", issues: ["t"] }] },
  },
  {
    name: "5 点名角色 -> 只退该角色",
    verdict: fail([{ role: "ui", text: "按钮错位" }]),
    expected: { kind: "retry", reopen: [{ stepId: "b", issues: ["按钮错位"] }] },
  },
  {
    name: "5 无角色问题 -> 退回全部来源角色并都带上",
    verdict: fail([{ role: null, text: "整体不通过" }]),
    expected: {
      kind: "retry",
      reopen: [
        { stepId: "a", issues: ["整体不通过"] },
        { stepId: "b", issues: ["整体不通过"] },
      ],
    },
  },
  {
    name: "5 没有任何问题 -> 退回全部来源角色，问题为空",
    verdict: fail([]),
    expected: {
      kind: "retry",
      reopen: [
        { stepId: "a", issues: [] },
        { stepId: "b", issues: [] },
      ],
    },
  },
  {
    name: "5 角色不在 from -> escalate",
    verdict: fail([{ role: "ops", text: "t" }]),
    expected: { kind: "escalate", reason: "verifyFailed" },
  },
  {
    name: "5 角色在运行里但不在 from -> escalate",
    steps: [...baseSteps(), view("z", "ops")],
    verdict: fail([{ role: "ops", text: "t" }]),
    expected: { kind: "escalate", reason: "verifyFailed" },
  },
  {
    name: "5 from 全是无角色步骤且无角色问题 -> escalate",
    steps: [
      view("a", null, { kind: "gate" }),
      view("b", null, { kind: "gate" }),
      baseSteps()[2]!,
    ],
    verdict: fail([{ role: null, text: "t" }]),
    expected: { kind: "escalate", reason: "verifyFailed" },
  },
  {
    name: "5/7 同一角色多步骤 -> 全部重开",
    steps: [view("a", "dev"), view("b", "dev"), baseSteps()[2]!],
    verdict: fail([{ role: "dev", text: "t" }]),
    expected: {
      kind: "retry",
      reopen: [
        { stepId: "a", issues: ["t"] },
        { stepId: "b", issues: ["t"] },
      ],
    },
  },
  {
    name: "7 角色问题与无角色问题合并，保持来源顺序",
    verdict: fail([
      { role: "ui", text: "u" },
      { role: null, text: "g" },
      { role: "dev", text: "d" },
    ]),
    expected: {
      kind: "retry",
      reopen: [
        { stepId: "a", issues: ["g", "d"] },
        { stepId: "b", issues: ["u", "g"] },
      ],
    },
  },
  {
    name: "6 目标未完成 -> escalate",
    steps: [view("a", "dev", { status: "running" }), view("b", "ui"), baseSteps()[2]!],
    verdict: fail([{ role: "dev", text: "t" }]),
    expected: { kind: "escalate", reason: "verifyFailed" },
  },
  {
    name: "6 目标是 gate -> escalate",
    steps: [view("a", "dev", { kind: "gate" }), view("b", "ui"), baseSteps()[2]!],
    verdict: fail([{ role: "dev", text: "t" }]),
    expected: { kind: "escalate", reason: "verifyFailed" },
  },
  {
    name: "6 目标缺视图 -> escalate",
    steps: [view("b", "ui"), baseSteps()[2]!],
    verdict: fail([{ role: null, text: "t" }]),
    expected: { kind: "retry", reopen: [{ stepId: "b", issues: ["t"] }] },
  },
  {
    name: "6 下游已开始（别的步骤 running）-> escalate",
    steps: [
      ...baseSteps(),
      view("d", "ops", { after: ["a"], status: "running" }),
    ],
    verdict: fail([{ role: "dev", text: "t" }]),
    expected: { kind: "escalate", reason: "verifyFailed" },
  },
  {
    name: "6 下游已结束（done）-> escalate",
    steps: [...baseSteps(), view("d", "ops", { after: ["a"], status: "done" })],
    verdict: fail([{ role: "dev", text: "t" }]),
    expected: { kind: "escalate", reason: "verifyFailed" },
  },
  {
    name: "6 下游仍 pending -> 可重开",
    steps: [...baseSteps(), view("d", "ops", { after: ["a"], status: "pending" })],
    verdict: fail([{ role: "dev", text: "t" }]),
    expected: { kind: "retry", reopen: [{ stepId: "a", issues: ["t"] }] },
  },
  {
    name: "6 本 collect 自己（running）不算下游",
    verdict: fail([{ role: "dev", text: "t" }]),
    expected: { kind: "retry", reopen: [{ stepId: "a", issues: ["t"] }] },
  },
  {
    name: "6 目标是已完成的 collect，可重开",
    steps: [
      view("a", "dev", { kind: "collect", after: ["x"] }),
      view("b", "ui"),
      baseSteps()[2]!,
    ],
    verdict: fail([{ role: "dev", text: "t" }]),
    expected: { kind: "retry", reopen: [{ stepId: "a", issues: ["t"] }] },
  },
];

describe("verifyDecision", () => {
  it.each(CASES)("$name", (c) => {
    expect(
      verifyDecision({
        step: c.step ?? collect(),
        round: c.round ?? 0,
        verdict: c.verdict,
        steps: c.steps ?? baseSteps(),
      }),
    ).toEqual(c.expected);
  });
});
