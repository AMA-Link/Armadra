import { describe, expect, it } from "vitest";
import { validAgentId } from "../agent/registry";
import {
  checkRendered,
  findCycle,
  parseDraft,
  renderPrompt,
  resolveParams,
} from "./draft";

/**
 * 草案校验（契约 §15.1）。与共享层 `workflowDraftSchema` 是同一套规则，
 * `packages/shared/test/api-workflows.test.ts` 用同样的样本钉住那一边。
 */

const RULES = { validAgentId };

function sample(): Record<string, unknown> {
  return {
    version: 1,
    title: "双人代码审查",
    params: [
      { name: "repo", type: "path" },
      { name: "scopeA", type: "string" },
    ],
    roles: [
      {
        id: "reviewerA",
        agentId: "claude",
        permissionMode: "plan",
        model: null,
        worktree: null,
      },
      { id: "reviewerB", agentId: "custom:reviewer" },
      { id: "lead", agentId: "codex", permissionMode: "default" },
    ],
    links: [{ from: "lead", to: "reviewerA" }],
    steps: [
      {
        id: "s1",
        kind: "prompt",
        role: "reviewerA",
        prompt: "审查 {{scopeA}}",
        after: [],
      },
      { id: "s2", kind: "prompt", role: "reviewerB", prompt: "审查 B" },
      {
        id: "s3",
        kind: "collect",
        role: "lead",
        from: ["s1", "s2"],
        prompt: "汇总",
        after: ["s1", "s2"],
      },
      { id: "s4", kind: "gate", label: "合并前人工确认", after: ["s3"] },
    ],
    source: { boardId: "b", nodeIds: ["n"], proposedBy: "ama", extra: 1 },
    unknown: "dropped",
  };
}

describe("parseDraft", () => {
  it("accepts the design's sample and fills the defaults", () => {
    const draft = parseDraft(sample(), RULES);
    expect(draft.title).toBe("双人代码审查");
    expect(draft.links).toEqual([
      { from: "lead", to: "reviewerA", role: "peer" },
    ]);
    expect(draft.steps[1]).toMatchObject({ after: [] });
    expect(draft).not.toHaveProperty("unknown");
    expect(draft.source).toEqual({
      boardId: "b",
      nodeIds: ["n"],
      proposedBy: "ama",
      sessionId: null,
    });
  });

  it("accepts the same draft as a JSON string", () => {
    expect(parseDraft(JSON.stringify(sample()), RULES).steps).toHaveLength(4);
  });

  it("refuses an agentId that is neither in the registry nor custom:", () => {
    const draft = sample();
    (draft.roles as Record<string, unknown>[])[0]!.agentId = "gpt-cli";
    expect(() => parseDraft(draft, RULES)).toThrow(/gpt-cli/);
    try {
      parseDraft(draft, RULES);
    } catch (error) {
      expect(error).toMatchObject({ status: 400, code: "invalid_draft" });
    }
  });

  it("refuses an after cycle and names it", () => {
    const draft = sample();
    const steps = draft.steps as Record<string, unknown>[];
    steps[0]!.after = ["s4"];
    expect(() => parseDraft(draft, RULES)).toThrow(/成环/);
  });

  it("refuses dangling references", () => {
    const unknownRole = sample();
    (unknownRole.steps as Record<string, unknown>[])[0]!.role = "ghost";
    expect(() => parseDraft(unknownRole, RULES)).toThrow(/ghost/);

    const unknownAfter = sample();
    (unknownAfter.steps as Record<string, unknown>[])[1]!.after = ["s9"];
    expect(() => parseDraft(unknownAfter, RULES)).toThrow(/s9/);

    const collectOutsideAfter = sample();
    (collectOutsideAfter.steps as Record<string, unknown>[])[2]!.after = ["s1"];
    expect(() => parseDraft(collectOutsideAfter, RULES)).toThrow(/after/);

    const selfLink = sample();
    selfLink.links = [{ from: "lead", to: "lead" }];
    expect(() => parseDraft(selfLink, RULES)).toThrow(/同一个角色/);
  });

  it("refuses bad shapes", () => {
    for (const mutate of [
      (draft: Record<string, unknown>) => {
        draft.version = 0;
      },
      (draft: Record<string, unknown>) => {
        draft.roles = [];
      },
      (draft: Record<string, unknown>) => {
        (draft.steps as Record<string, unknown>[])[0]!.kind = "loop";
      },
      (draft: Record<string, unknown>) => {
        (draft.roles as Record<string, unknown>[])[0]!.permissionMode = "yolo";
      },
      (draft: Record<string, unknown>) => {
        (draft.roles as Record<string, unknown>[])[1]!.id = "reviewerA";
      },
      (draft: Record<string, unknown>) => {
        (draft.steps as Record<string, unknown>[])[0]!.prompt = "x".repeat(
          2_001,
        );
      },
    ]) {
      const draft = sample();
      mutate(draft);
      expect(() => parseDraft(draft, RULES)).toThrow();
    }
    expect(() => parseDraft("{", RULES)).toThrow(/JSON/);
    expect(() => parseDraft([], RULES)).toThrow();
  });
});

describe("v2 fields", () => {
  const v2 = (): Record<string, unknown> => {
    const draft = sample();
    (draft.roles as Record<string, unknown>[])[0]!.tier = "strong";
    const collect = (draft.steps as Record<string, unknown>[])[2]!;
    collect.verify = { commands: ["pnpm test"], checklist: ["无遗漏"] };
    collect.maxRetries = 1;
    draft.description = "说明";
    draft.contract = {
      text: "共享约定",
      owns: { reviewerA: ["src/a/"], lead: [] },
    };
    return draft;
  };
  const refuse = (mutate: (draft: Record<string, unknown>) => void): void => {
    const draft = v2();
    mutate(draft);
    expect(() => parseDraft(draft, RULES)).toThrow(
      expect.objectContaining({ code: "invalid_draft" }),
    );
  };
  const collectOf = (draft: Record<string, unknown>): Record<string, unknown> =>
    (draft.steps as Record<string, unknown>[])[2]!;

  it("accepts a v2 draft and writes version 2 back, glob untouched", () => {
    const draft = parseDraft(v2(), RULES);
    expect(draft.version).toBe(2);
    expect(draft.roles[0]).toMatchObject({ tier: "strong" });
    expect(draft.steps[2]).toMatchObject({
      verify: { commands: ["pnpm test"], checklist: ["无遗漏"] },
      maxRetries: 1,
    });
    expect(draft.description).toBe("说明");
    expect(draft.contract).toEqual({
      text: "共享约定",
      owns: { reviewerA: ["src/a/"], lead: [] },
    });
  });

  it("reads any version >= 1 and always writes 2", () => {
    for (const version of [1, 2, 7]) {
      expect(parseDraft({ ...sample(), version }, RULES).version).toBe(2);
    }
  });

  it("does not write absent optional fields or defaults back", () => {
    const draft = parseDraft(sample(), RULES);
    for (const key of ["description", "contract"]) {
      expect(draft).not.toHaveProperty(key);
    }
    expect(draft.roles[0]).not.toHaveProperty("tier");
    expect(draft.steps[2]).not.toHaveProperty("verify");
    expect(draft.steps[2]).not.toHaveProperty("maxRetries");
    expect(draft.params[0]).not.toHaveProperty("default");
  });

  it("checks the tier", () => {
    refuse((draft) => {
      (draft.roles as Record<string, unknown>[])[0]!.tier = "ultra";
    });
    const draft = v2();
    (draft.roles as Record<string, unknown>[])[0]!.tier = null;
    expect(parseDraft(draft, RULES).roles[0]).not.toHaveProperty("tier");
  });

  it("checks verify and maxRetries", () => {
    refuse((draft) => {
      collectOf(draft).verify = {};
    });
    refuse((draft) => {
      collectOf(draft).verify = { commands: [], checklist: [] };
    });
    refuse((draft) => {
      collectOf(draft).verify = { commands: Array(5).fill("x") };
    });
    refuse((draft) => {
      collectOf(draft).verify = { commands: ["x".repeat(301)] };
    });
    refuse((draft) => {
      collectOf(draft).verify = { checklist: Array(17).fill("x") };
    });
    refuse((draft) => {
      collectOf(draft).verify = { checklist: ["x".repeat(301)] };
    });
    refuse((draft) => {
      collectOf(draft).maxRetries = 4;
    });
    refuse((draft) => {
      collectOf(draft).maxRetries = 1.5;
    });
    refuse((draft) => {
      delete collectOf(draft).verify;
    });
    const edge = v2();
    collectOf(edge).maxRetries = 0;
    expect(parseDraft(edge, RULES).steps[2]).toMatchObject({ maxRetries: 0 });
    const full = v2();
    collectOf(full).verify = {
      commands: Array(4).fill("x".repeat(300)),
      checklist: Array(16).fill("x".repeat(300)),
    };
    expect(() => parseDraft(full, RULES)).not.toThrow();
  });

  it("checks contract.text, owns keys and owns sizes", () => {
    refuse((draft) => {
      draft.contract = { text: "x".repeat(6_001) };
    });
    refuse((draft) => {
      draft.contract = { owns: { ghost: ["a"] } };
    });
    refuse((draft) => {
      draft.contract = { owns: { lead: "src/**" } };
    });
    refuse((draft) => {
      draft.contract = { owns: { lead: Array(17).fill("a") } };
    });
    refuse((draft) => {
      draft.contract = { owns: { lead: ["x".repeat(201)] } };
    });
    // glob 语法与跨角色冲突此时不查。
    const draft = v2();
    draft.contract = {
      owns: { reviewerA: ["src/a/**"], reviewerB: ["src/**/x.ts"] },
    };
    expect(() => parseDraft(draft, RULES)).not.toThrow();
  });

  it("checks description length", () => {
    refuse((draft) => {
      draft.description = "x".repeat(4_001);
    });
    const draft = v2();
    draft.description = "x".repeat(4_000);
    expect(() => parseDraft(draft, RULES)).not.toThrow();
  });

  it("counts the 200 reserve only for collect and contracted prompt steps", () => {
    const plain = parseDraft(sample(), RULES);
    const long = { scopeA: "x".repeat(1_900), repo: "." };
    // 无约定的 prompt 步骤满额也行。
    expect(() =>
      checkRendered(plain, { scopeA: "x".repeat(1_990), repo: "." }),
    ).not.toThrow();
    const contracted = parseDraft(
      {
        ...sample(),
        contract: { owns: { reviewerA: ["src/"] } },
      },
      RULES,
    );
    // s1 属于 reviewerA（有 owns）：代入后 1_900 + 7 + 200 > 2000。
    expect(() => checkRendered(contracted, long)).toThrow(
      expect.objectContaining({ code: "prompt_too_long" }),
    );
    expect(() =>
      checkRendered(contracted, { scopeA: "x".repeat(1_790), repo: "." }),
    ).not.toThrow();
    const texted = parseDraft(
      { ...sample(), contract: { text: "约定" } },
      RULES,
    );
    expect(() => checkRendered(texted, long)).toThrow();
    // collect 总是留余量（按码点）。
    const collect = parseDraft(
      {
        ...sample(),
        steps: [
          {
            id: "c",
            kind: "collect",
            role: "lead",
            from: ["p"],
            prompt: "汇".repeat(1_801),
            after: ["p"],
          },
          { id: "p", kind: "prompt", role: "reviewerA", prompt: "x" },
        ],
      },
      RULES,
    );
    expect(() => checkRendered(collect, {})).toThrow();
  });
});

describe("findCycle", () => {
  it("returns the loop, or nothing", () => {
    expect(
      findCycle([
        { id: "a", after: ["c"] },
        { id: "b", after: ["a"] },
        { id: "c", after: ["b"] },
      ]),
    ).toEqual(["a", "c", "b", "a"]);
    expect(
      findCycle([
        { id: "a", after: [] },
        { id: "b", after: ["a"] },
      ]),
    ).toBeUndefined();
  });
});

describe("params", () => {
  it("fills defaults, refuses unknown and missing ones, and renders", () => {
    const draft = parseDraft(
      {
        ...sample(),
        params: [
          { name: "scopeA", type: "string" },
          { name: "repo", type: "path", default: "." },
        ],
      },
      RULES,
    );
    expect(resolveParams(draft, { scopeA: "src/x" })).toEqual({
      scopeA: "src/x",
      repo: ".",
    });
    expect(() => resolveParams(draft, {})).toThrow(
      expect.objectContaining({ code: "missing_param" }),
    );
    expect(() => resolveParams(draft, { scopeA: "a", other: "b" })).toThrow(
      /other/,
    );
    expect(renderPrompt("看 {{ scopeA }} 与 {{nope}}", { scopeA: "a" })).toBe(
      "看 a 与 {{nope}}",
    );
    expect(() =>
      checkRendered(draft, { scopeA: "x".repeat(1_999), repo: "." }),
    ).toThrow(expect.objectContaining({ code: "prompt_too_long" }));
  });
});
