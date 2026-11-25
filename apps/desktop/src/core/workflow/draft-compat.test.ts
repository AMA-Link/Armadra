import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  globsOverlap,
  parseWorkflowFile,
  validateOwnsGlob,
} from "@armadra/agent/workflow";
import vectors from "@armadra/agent/workflow-glob-vectors.json";
import { validAgentId } from "../agent/registry";
import { parseDraft } from "./draft";

/**
 * 与 ama 的兼容（契约 §15.1、多 Agent 工作流设计稿 §5）：同一份文件，ama 的
 * `parseWorkflowFile` 与 Armadra 的 `parseDraft` 结论一致；只有两处是有意保留的
 * 差异——ama 拒绝未知字段、ama 只认 `version: 2`，Armadra 都接受（D13、D22）。
 * 文件样本取自 ama 仓库的 `test/fixtures/workflows/`。
 */

const RULES = { validAgentId };

const FILES: Record<string, string> = {
  "valid-minimal": `---
version: 2
title: One step
roles:
  - id: a
    agentId: ama
steps:
  - id: only
    kind: prompt
    role: a
    prompt: Do the thing.
---
`,
  "valid-full": `---
version: 2
title: Split a feature into API and UI
params:
  - name: feature
    type: text
    label: What to build
roles:
  - id: api
    agentId: ama
    tier: strong
    worktree: api
  - id: ui
    agentId: ama
    tier: standard
    worktree: ui
  - id: lead
    agentId: ama
    tier: strong
contract:
  text: |
    Interface: POST /api/items -> { id: string }
    Constraint: no new runtime dependencies.
  owns:
    api: ["src/server/"]
    ui: ["src/web/**"]
steps:
  - id: build-api
    kind: prompt
    role: api
    prompt: "Implement the server side of {{feature}}."
  - id: build-ui
    kind: prompt
    role: ui
    prompt: "Implement the UI of {{feature}} against the contract."
  - id: review
    kind: gate
    label: Review both parts before merging
    after: [build-api, build-ui]
  - id: integrate
    kind: collect
    role: lead
    from: [build-api, build-ui]
    after: [review, build-api, build-ui]
    prompt: Merge both branches and summarize what changed.
    verify:
      commands: ["pnpm test"]
      checklist: ["The API route exists", "The UI calls it"]
    maxRetries: 1
---

For people: this workflow builds the API and the UI in parallel.

It is never sent to a model.
`,
  "valid-armadra-fields": `---
version: 2
title: Two-reviewer code review
params:
  - name: repo
    type: path
  - name: scopeA
    default: src/a
roles:
  - id: reviewerA
    agentId: claude
    permissionMode: plan
  - id: reviewerB
    agentId: custom:reviewer
  - id: lead
    agentId: codex
    permissionMode: default
links:
  - from: lead
    to: reviewerA
steps:
  - id: s1
    kind: prompt
    role: reviewerA
    prompt: Review {{scopeA}} in {{repo}}
  - id: s2
    kind: prompt
    role: reviewerB
    prompt: Review B
  - id: s3
    kind: collect
    role: lead
    from: [s1, s2]
    after: [s1, s2]
    prompt: Summarize both reviews
  - id: s4
    kind: gate
    label: Human check before merging
    after: [s3]
source:
  boardId: board-1
  nodeIds: [n1, n2]
  proposedBy: ama
---
`,
  "invalid-cycle": `---
version: 2
title: Cycle
roles:
  - id: a
    agentId: ama
steps:
  - id: s1
    kind: prompt
    role: a
    prompt: x
    after: [s2]
  - id: s2
    kind: prompt
    role: a
    prompt: y
    after: [s1]
---
`,
  "invalid-collect-from": `---
version: 2
title: Collect
roles:
  - id: a
    agentId: ama
steps:
  - id: s1
    kind: prompt
    role: a
    prompt: x
  - id: s2
    kind: prompt
    role: a
    prompt: y
  - id: c
    kind: collect
    role: a
    from: [s1, s2]
    after: [s1]
    prompt: gather
---
`,
  "invalid-owns-role": `---
version: 2
title: Owns
roles:
  - id: a
    agentId: ama
contract:
  owns:
    ghost: ["src/"]
steps:
  - id: s
    kind: prompt
    role: a
    prompt: x
---
`,
  "invalid-glob": `---
version: 2
title: Glob
roles:
  - id: a
    agentId: ama
contract:
  owns:
    a: ["../outside"]
steps:
  - id: s
    kind: prompt
    role: a
    prompt: x
---
`,
  "invalid-owns-overlap": `---
version: 2
title: Overlap
roles:
  - id: a
    agentId: ama
  - id: b
    agentId: ama
contract:
  owns:
    a: ["src/**"]
    b: ["src/web/"]
steps:
  - id: s
    kind: prompt
    role: a
    prompt: x
---
`,
  "invalid-retries-without-verify": `---
version: 2
title: Retries
roles:
  - id: a
    agentId: ama
steps:
  - id: s1
    kind: prompt
    role: a
    prompt: x
  - id: c
    kind: collect
    role: a
    from: [s1]
    after: [s1]
    prompt: gather
    maxRetries: 1
---
`,
  "invalid-custom-suffix": `---
version: 2
title: Custom
roles:
  - id: a
    agentId: "custom:${"a".repeat(65)}"
steps:
  - id: s
    kind: prompt
    role: a
    prompt: x
---
`,
};

/** 与 ama 的 `parseWorkflowFile` 同样切 frontmatter 与正文，交给 `js-yaml`。 */
function armadraReads(text: string): boolean {
  const lines = text.split(/\r?\n/);
  const close = lines.findIndex((line, index) => index > 0 && line === "---");
  const frontmatter = load(lines.slice(1, close).join("\n")) as Record<
    string,
    unknown
  >;
  const body = lines
    .slice(close + 1)
    .join("\n")
    .trim();
  try {
    parseDraft(
      { ...frontmatter, ...(body === "" ? {} : { description: body }) },
      RULES,
    );
    return true;
  } catch {
    return false;
  }
}

const amaReads = (text: string): boolean =>
  parseWorkflowFile(text).workflow !== undefined;

describe("ama 的文件样本", () => {
  it.each(Object.keys(FILES))("%s：两边结论一致", (name) => {
    const text = FILES[name] as string;
    const expected = name.startsWith("valid-");
    expect(amaReads(text)).toBe(expected);
    expect(armadraReads(text)).toBe(expected);
  });

  it("ama 拒绝、Armadra 接受：未知字段", () => {
    const text = `---
version: 2
title: Typo
roles:
  - id: a
    agentId: ama
    tir: strong
steps:
  - id: s
    kind: prompt
    role: a
    prompt: x
---
`;
    expect(amaReads(text)).toBe(false);
    expect(armadraReads(text)).toBe(true);
  });

  it("ama 拒绝、Armadra 接受：version 1（Armadra 读 ≥ 1、写恒为 2）", () => {
    const text = `---
version: 1
title: Old
roles:
  - id: a
    agentId: ama
steps:
  - id: s
    kind: prompt
    role: a
    prompt: x
---
`;
    expect(amaReads(text)).toBe(false);
    expect(armadraReads(text)).toBe(true);
    const parsed = parseDraft(
      {
        version: 1,
        title: "Old",
        roles: [{ id: "a", agentId: "ama" }],
        steps: [{ id: "s", kind: "prompt", role: "a", prompt: "x" }],
      },
      RULES,
    );
    expect(parsed.version).toBe(2);
  });

  it("acp:* ama 认、Armadra 不认", () => {
    const text = `---
version: 2
title: Acp
roles:
  - id: a
    agentId: "acp:some-agent"
steps:
  - id: s
    kind: prompt
    role: a
    prompt: x
---
`;
    expect(amaReads(text)).toBe(true);
    expect(armadraReads(text)).toBe(false);
  });
});

describe("owns 的 glob 向量", () => {
  const draftOf = (owns: Record<string, string[]>) => ({
    version: 2,
    title: "t",
    roles: [
      { id: "a", agentId: "ama" },
      { id: "b", agentId: "ama" },
    ],
    steps: [{ id: "s", kind: "prompt", role: "a", prompt: "x" }],
    contract: { owns },
  });

  it("有 40 条以上，两个函数与向量一致", () => {
    expect(
      vectors.overlap.length + vectors.valid.length,
    ).toBeGreaterThanOrEqual(40);
    for (const vector of vectors.valid) {
      expect(validateOwnsGlob(vector.glob) === undefined).toBe(vector.valid);
    }
    for (const vector of vectors.overlap) {
      expect(globsOverlap(vector.a, vector.b)).toBe(vector.overlap);
    }
  });

  it.each(vectors.valid.map((vector) => [vector.glob, vector.valid] as const))(
    "语法 %s -> %s",
    (glob, valid) => {
      const attempt = () => parseDraft(draftOf({ a: [glob] }), RULES);
      if (valid) expect(attempt).not.toThrow();
      else expect(attempt).toThrow(/contract\.owns/);
    },
  );

  it.each(
    vectors.overlap.map(
      (vector) => [vector.a, vector.b, vector.overlap] as const,
    ),
  )("冲突 %s 与 %s -> %s", (a, b, overlap) => {
    const attempt = () => parseDraft(draftOf({ a: [a], b: [b] }), RULES);
    if (overlap) expect(attempt).toThrow(/可能指向同一个文件/);
    else expect(attempt).not.toThrow();
  });
});
