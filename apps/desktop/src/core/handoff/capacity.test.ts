import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture } from "../agent/fixture";
import { setAdapterProbeForTest } from "../collab/control/agent-driver";
import type { Catalog, CatalogModel } from "../models/catalog";
import { EMPTY_SECTIONS } from "./bundle";
import {
  BYTES_PER_TOKEN,
  modelCapacity,
  reservedFor,
  setCapacityCatalogForTest,
} from "./capacity";
import { prepare } from "./store";

/** 目标模型的上下文容量与交接包的 token 预算（契约 §39.8）。 */

function model(
  provider: string,
  modelId: string,
  context: number | undefined,
  output?: number,
): CatalogModel {
  return {
    provider,
    modelId,
    name: modelId,
    limit: {
      ...(context === undefined ? {} : { context }),
      ...(output === undefined ? {} : { output }),
    },
    reasoning: false,
  };
}

function catalog(models: CatalogModel[]): Catalog {
  return {
    version: 1,
    source: "builtIn",
    url: "https://models.dev/api.json",
    models,
  };
}

beforeEach(() => {
  setCapacityCatalogForTest(() =>
    catalog([
      model("openai", "gpt-5", 400_000, 128_000),
      model("openai", "tiny", 3_000, 500),
      model("anthropic", "claude-opus-4-1", 200_000, 32_000),
      model("someone", "shared", 100_000),
      model("other", "shared", 50_000),
      model("openai", "no-limit", undefined),
    ]),
  );
});

afterEach(() => setCapacityCatalogForTest());

describe("modelCapacity", () => {
  it("reserves the larger of the output limit and a quarter, never more than half", () => {
    expect(reservedFor(400_000, 128_000)).toBe(128_000);
    expect(reservedFor(400_000, undefined)).toBe(100_000);
    expect(reservedFor(3_000, 2_900)).toBe(1_500);
    expect(modelCapacity("codex", "gpt-5")).toEqual({
      capacityTokens: 400_000,
      reservedTokens: 128_000,
      availableTokens: 272_000,
    });
  });

  it("looks a built-in agent's model up under its own provider, case-insensitively", () => {
    expect(modelCapacity("claude", "Claude-Opus-4-1")?.capacityTokens).toBe(
      200_000,
    );
    // claude 的模型不会去别家的目录里找。
    expect(modelCapacity("claude", "gpt-5")).toBeUndefined();
  });

  it("takes the smallest limit when the agent can talk to any provider", () => {
    expect(modelCapacity("opencode", "shared")?.capacityTokens).toBe(50_000);
  });

  it("honours an explicit [1m] suffix", () => {
    expect(modelCapacity("claude", "claude-opus-4-1[1m]")?.capacityTokens).toBe(
      1_000_000,
    );
  });

  it("answers nothing for an alias, a model without a context limit, or no model", () => {
    expect(modelCapacity("claude", "opus")).toBeUndefined();
    expect(modelCapacity("codex", "no-limit")).toBeUndefined();
    expect(modelCapacity("codex", null)).toBeUndefined();
    setCapacityCatalogForTest(() => undefined);
    expect(modelCapacity("codex", "gpt-5")).toBeUndefined();
  });
});

describe("the bundle's token budget", () => {
  let fixture: AgentFixture;
  let source: string;
  let sourceSession: string;

  beforeEach(() => {
    setAdapterProbeForTest((program) => `/usr/bin/${program}`);
    fixture = agentFixture();
    source = fixture.agentNode("Source");
    sourceSession = fixture.session(source, "claude");
  });
  afterEach(() => {
    setAdapterProbeForTest();
    fixture.close();
  });

  function make(
    spec: Record<string, unknown>,
    sections: Partial<typeof EMPTY_SECTIONS> = {},
  ) {
    return prepare(fixture.collab, fixture.workspaceId, {
      sourceNodeId: source,
      sourceSessionId: sourceSession,
      sourceGeneration: 1,
      target: { kind: "new", spec },
      sections: { ...EMPTY_SECTIONS, goal: "go", ...sections },
      filePaths: [],
      byteBudget: 8192,
      includeTranscript: false,
    } as never);
  }

  it("fills capacity, reserve, available and an estimate when the model is known", async () => {
    const view = await make({
      agentId: "codex",
      model: "gpt-5",
      surface: "terminal",
    });
    const budget = view.bundle.budget;
    expect(budget).toMatchObject({
      byteLimit: 8192,
      capacityTokens: 400_000,
      reservedTokens: 128_000,
      availableTokens: 272_000,
    });
    expect(budget.tokenEstimate).toBe(
      Math.ceil(budget.usedBytes / BYTES_PER_TOKEN),
    );
    expect(budget.omitted).not.toContain("tokenBudgetUnavailable");
    expect(budget.omitted).not.toContain("modelCapacityLimitsBudget");
  });

  it("keeps the byte budget and says so when the model is not in the catalog", async () => {
    const view = await make({
      agentId: "claude",
      model: "opus",
      surface: "terminal",
    });
    expect(view.bundle.budget).toMatchObject({
      byteLimit: 8192,
      tokenEstimate: null,
      capacityTokens: null,
      availableTokens: null,
      reservedTokens: null,
    });
    expect(view.bundle.budget.omitted).toContain("tokenBudgetUnavailable");
    const bare = await make({ agentId: "codex", surface: "terminal" });
    expect(bare.bundle.budget.omitted).toContain("tokenBudgetUnavailable");
  });

  it("trims to whichever of the byte and token budgets is tighter", async () => {
    const view = await make(
      { agentId: "codex", model: "tiny", surface: "terminal" },
      { completed: "x".repeat(7_000) },
    );
    const budget = view.bundle.budget;
    // 3000 token 容量，保留 750，可用 2250 token = 6750 字节，紧于 8192。
    expect(budget).toMatchObject({
      capacityTokens: 3_000,
      reservedTokens: 750,
      availableTokens: 2_250,
      byteLimit: 6_750,
      truncated: true,
    });
    expect(budget.usedBytes).toBeLessThanOrEqual(6_750);
    expect(budget.omitted).toContain("modelCapacityLimitsBudget");
    expect(budget.omitted).toContain("truncated:completed");
    expect(view.bundle.sections.goal).toBe("go");
  });

  it("uses the model recorded on an existing target node", async () => {
    const target = fixture.agentNode("Target", "codex");
    fixture.database
      .prepare(
        "UPDATE nodes SET data_json = json_set(data_json, '$.agent.model', 'gpt-5') WHERE id = ?",
      )
      .run(target);
    fixture.link(source, target);
    const view = await prepare(fixture.collab, fixture.workspaceId, {
      sourceNodeId: source,
      sourceSessionId: sourceSession,
      sourceGeneration: 1,
      target: {
        kind: "node",
        nodeId: target,
        sessionId: fixture.session(target, "codex"),
        generation: 1,
      },
      sections: { ...EMPTY_SECTIONS, goal: "go" },
      filePaths: [],
      byteBudget: 8192,
      includeTranscript: false,
    } as never);
    expect(view.bundle.target.modelId).toBe("gpt-5");
    expect(view.bundle.budget.capacityTokens).toBe(400_000);
  });
});
