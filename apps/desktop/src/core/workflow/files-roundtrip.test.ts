import { describe, expect, it } from "vitest";
import { parseWorkflowFile } from "@armadra/agent/workflow";
import { validAgentId } from "../agent/registry";
import { parseDraft } from "./draft";
import { formatDraft } from "./files";

/**
 * 往返一致（契约 §121）：草案写成文件再读回深相等（`source` 除外：它是本机画布的来历，
 * 不进文件）；ama 的示例文件导入再导出，两次 `ama.parse` 深相等（同样除 `source`）。不要求字节相同——两边都不规整 glob、不写回缺省值。
 */

const RULES = { validAgentId };

const SAMPLES: Record<string, string> = {
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
};

const amaOf = (text: string) => parseWorkflowFile(text).workflow;
const draftOf = (text: string) => parseDraft(amaOf(text), RULES);
/** 文件不带 `source`：比较前去掉。 */
const noSource = <T extends object>(value: T) => {
  const { source: _source, ...rest } = value as T & { source?: unknown };
  return rest;
};

describe("工作流文件的往返", () => {
  it.each(Object.keys(SAMPLES))(
    "%s：parseDraft(ama.parse(format(d))) 与 d 深相等（除 source）",
    (name) => {
      const d = draftOf(SAMPLES[name] as string);
      expect(draftOf(formatDraft(d))).toEqual(noSource(d));
    },
  );

  it.each(Object.keys(SAMPLES))(
    "%s：导入再导出，两次 ama.parse 深相等（除 source）",
    (name) => {
      const text = SAMPLES[name] as string;
      const exported = formatDraft(draftOf(text));
      expect(noSource(amaOf(exported) as object)).toEqual(
        noSource(amaOf(text) as object),
      );
    },
  );

  it("source 不写进文件", () => {
    const d = draftOf(SAMPLES["valid-armadra-fields"] as string);
    expect(d.source).toMatchObject({ boardId: "board-1" });
    const text = formatDraft(d);
    expect(text).not.toMatch(/source|board-1|proposedBy/);
    expect(draftOf(text).source).toBeUndefined();
  });

  it("不写回缺省值，不规整 glob，空 contract 不写", () => {
    const text = formatDraft(
      draftOf(SAMPLES["valid-armadra-fields"] as string),
    );
    expect(text).not.toMatch(/type: string/);
    expect(text).not.toMatch(/role: peer/);
    expect(text).not.toMatch(/after: \[\]/);
    const d = draftOf(SAMPLES["valid-full"] as string);
    expect(formatDraft(d)).toContain("src/server/");
    const bare = parseDraft(
      {
        version: 2,
        title: "t",
        roles: [{ id: "a", agentId: "codex" }],
        steps: [{ id: "s", kind: "prompt", role: "a", prompt: "x" }],
        contract: {},
      },
      RULES,
    );
    expect(formatDraft(bare)).not.toMatch(/contract/);
  });

  it("旧格式号的草案写出来是 2", () => {
    const old = parseDraft(
      {
        version: 1,
        title: "旧",
        roles: [{ id: "a", agentId: "codex" }],
        steps: [{ id: "s", kind: "prompt", role: "a", prompt: "x" }],
      },
      RULES,
    );
    expect(formatDraft(old)).toMatch(/^---\nversion: 2\n/);
  });
});
