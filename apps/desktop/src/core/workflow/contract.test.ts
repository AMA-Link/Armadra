import { describe, expect, it } from "vitest";
import {
  STEP_NOTE_RESERVE,
  contractMessages,
  feedbackBody,
  stepSuffix,
  verifyMessage,
} from "./contract";
import type { CollectStep, PromptStep, WorkflowDraft } from "./types";

function draft(extra: Partial<WorkflowDraft> = {}): WorkflowDraft {
  return {
    version: 2,
    title: "t",
    params: [],
    roles: [
      { id: "a", agentId: "claude" },
      { id: "b", agentId: "codex" },
      { id: "lead", agentId: "claude" },
    ],
    links: [],
    steps: [
      { id: "s1", kind: "prompt", role: "a", prompt: "x", after: [] },
      { id: "s2", kind: "prompt", role: "b", prompt: "y", after: [] },
      {
        id: "s3",
        kind: "collect",
        role: "lead",
        from: ["s1", "s2"],
        prompt: "z",
        after: ["s1", "s2"],
      },
    ],
    ...extra,
  };
}

const collect = (d: WorkflowDraft): CollectStep => d.steps[2] as CollectStep;

describe("contractMessages", () => {
  it("is empty without a contract", () => {
    expect(contractMessages(draft(), "a")).toEqual([]);
    expect(contractMessages(draft({ contract: {} }), "a")).toEqual([]);
  });

  it("lists own and others' paths first, glob untouched, then the text paragraphs", () => {
    const d = draft({
      contract: {
        text: "第一段\n\n第二段\n\n\n第三段",
        owns: { a: ["src/a/"], b: ["docs/**"] },
      },
    });
    const messages = contractMessages(d, "a");
    expect(messages).toHaveLength(4);
    expect(messages[0]).toContain("- src/a/");
    expect(messages[0]).toContain("b：");
    expect(messages[0]).toContain("- docs/**");
    expect(messages.slice(1)).toEqual(["第一段", "第二段", "第三段"]);
    // 没有 owns 的角色也能看到别人的路径。
    expect(contractMessages(d, "lead")[0]).toContain("（未指定）");
  });

  it("omits the path message when nothing is owned, and keeps every part within 2000", () => {
    const d = draft({ contract: { text: "段".repeat(4_500) } });
    const messages = contractMessages(d, "a");
    expect(messages.map((m) => [...m].length)).toEqual([2_000, 2_000, 500]);
    const owns = Object.fromEntries(
      ["a", "b", "lead"].map((id) => [id, Array(16).fill("p".repeat(200))]),
    );
    for (const m of contractMessages(draft({ contract: { owns } }), "a")) {
      expect([...m].length).toBeLessThanOrEqual(2_000);
    }
  });
});

describe("contractMessages path ownership", () => {
  it("keeps every own path by splitting into several messages, only others are cut", () => {
    const own = Array.from({ length: 16 }, (_, i) => `${i}-${"p".repeat(195)}`);
    const owns = {
      a: own,
      b: Array(16).fill("q".repeat(200)),
      lead: Array(16).fill("r".repeat(200)),
    };
    const messages = contractMessages(draft({ contract: { owns } }), "a");
    expect(messages.length).toBeGreaterThan(1);
    for (const m of messages) {
      expect([...m].length).toBeLessThanOrEqual(2_000);
    }
    const all = messages.join("\n");
    for (const glob of own) expect(all).toContain(`- ${glob}`);
    expect(messages[0]).toMatch(/^你负责的路径：/);
    expect(messages[1]).toMatch(/^你负责的路径（续）：/);
    expect(all).toMatch(/另有 \d+ 条未列出/);
  });
});

describe("round numbering", () => {
  it("shows round + 1 to the agent", () => {
    const d = draft();
    const step: CollectStep = { ...collect(d), verify: { commands: ["x"] } };
    expect(verifyMessage(d, step, 0)).toContain("第 1 轮");
    expect(verifyMessage(d, step, 2)).toContain("第 3 轮");
    expect(
      feedbackBody({
        collectStepId: "s3",
        round: 0,
        issues: ["x"],
        hasContract: false,
      }),
    ).toContain("第 1 轮");
  });
});

describe("verifyMessage", () => {
  it("is undefined without verify", () => {
    expect(verifyMessage(draft(), collect(draft()), 1)).toBeUndefined();
  });

  it("names commands, checklist, source roles and the verdict usage", () => {
    const d = draft();
    const step: CollectStep = {
      ...collect(d),
      verify: { commands: ["pnpm test"], checklist: ["无遗漏"] },
    };
    const text = verifyMessage(d, step, 2)!;
    expect(text).toContain("$ pnpm test");
    expect(text).toContain("- 无遗漏");
    expect(text).toContain("a、b");
    expect(text).toContain("canvas_workflow_verdict --pass");
    expect(text).toContain("--issue");
    expect(text).toContain("s3");
  });

  it("stays within 2000 and says how many items were dropped", () => {
    const d = draft();
    const step: CollectStep = {
      ...collect(d),
      verify: {
        commands: Array(4).fill("c".repeat(300)),
        checklist: Array(16).fill("i".repeat(300)),
      },
    };
    const text = verifyMessage(d, step, 1)!;
    expect([...text].length).toBeLessThanOrEqual(2_000);
    expect(text).toMatch(/另有 \d+ 条未列出/);
    expect(text).toContain("canvas_workflow_verdict --pass");
  });
});

describe("stepSuffix", () => {
  it("is empty for a plain prompt step", () => {
    expect(stepSuffix(draft(), draft().steps[0] as PromptStep)).toBe("");
  });

  it("fits within 200 for every combination and carries no ids or lists", () => {
    const verifies = [
      undefined,
      { commands: ["pnpm test"] },
      { commands: ["a".repeat(300)], checklist: ["b".repeat(300)] },
    ];
    const contracts = [
      undefined,
      { text: "t" },
      { owns: { lead: ["x"], a: ["y"] } },
      { text: "t", owns: { lead: ["x"], a: ["y"] } },
    ];
    for (const verify of verifies) {
      for (const contract of contracts) {
        const d = draft(contract === undefined ? {} : { contract });
        const step: CollectStep = {
          ...collect(d),
          from: ["s1", "s2"],
          ...(verify === undefined ? {} : { verify }),
        };
        for (const target of [
          step,
          d.steps[0] as PromptStep,
          d.steps[1] as PromptStep,
        ]) {
          const text = stepSuffix(d, target);
          expect([...text].length).toBeLessThanOrEqual(STEP_NOTE_RESERVE);
          expect(text).not.toMatch(/s1|s2|s3|pnpm|\bs\d\b/);
        }
        const suffix = stepSuffix(d, step);
        expect(suffix).toContain("来源步骤的结论");
        expect(suffix.includes("共享约定")).toBe(contract !== undefined);
        expect(suffix.includes("canvas_workflow_verdict")).toBe(
          verify !== undefined,
        );
      }
    }
  });

  it("mentions the contract on a contracted prompt step", () => {
    const d = draft({ contract: { owns: { a: ["src/"] } } });
    expect(stepSuffix(d, d.steps[0] as PromptStep)).toContain("共享约定");
    expect(stepSuffix(d, d.steps[1] as PromptStep)).toBe("");
  });
});

describe("feedbackBody", () => {
  it("lists the issues and points at the contract when there is one", () => {
    const text = feedbackBody({
      collectStepId: "s3",
      round: 1,
      issues: ["a: 缺测试", "b: 命名不一致"],
      hasContract: true,
    });
    expect(text).toContain("s3");
    expect(text).toContain("- a: 缺测试");
    expect(text).toContain("共享约定");
    expect(
      feedbackBody({
        collectStepId: "s3",
        round: 1,
        issues: ["x"],
        hasContract: false,
      }),
    ).not.toContain("共享约定");
  });

  it("truncates to 2000 and notes the remainder", () => {
    const text = feedbackBody({
      collectStepId: "s3",
      round: 2,
      issues: Array.from(
        { length: 40 },
        (_, i) => `r: ${"问".repeat(200)}${i}`,
      ),
      hasContract: true,
    });
    expect([...text].length).toBeLessThanOrEqual(2_000);
    expect(text).toMatch(/另有 \d+ 条未列出/);
    expect(text).toContain("共享约定");
  });
});
