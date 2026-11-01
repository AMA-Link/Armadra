import { describe, expect, it } from "vitest";
import { AGENT_IDS, type TimelineItem } from "@armadra/shared";

import { user } from "@/timeline/test-support";
import {
  DEFAULT_MODEL_ID,
  candidateModels,
  candidateModes,
  firstMessageSent,
  pickModels,
  pickModes,
  visibleUsage,
} from "./pickers";

const name = (mode: string) => `n:${mode}`;

function turn(n: number, error?: boolean): TimelineItem {
  return {
    id: `turn:${n}`,
    kind: "turn",
    turn: n,
    ord: 9,
    rev: 0,
    source: "acp",
    at: 1,
    gen: 1,
    turnId: `t${n}`,
    startedAt: 1,
    permissionWaitMs: 0,
    ...(error ? { error: { code: "x", message: "boom" } } : {}),
  } as TimelineItem;
}

describe("candidateModes", () => {
  it("offers every switchable mode, bypass included, per agent", () => {
    const ids = (agent: string) =>
      candidateModes(agent, undefined, name)?.availableModes.map((m) => m.id) ??
      null;
    expect(ids("claude")).toEqual([
      "default",
      "acceptEdits",
      "bypassPermissions",
      "plan",
    ]);
    expect(ids("codex")).toEqual([
      "workspace-write",
      "agent",
      "agent-full-access",
      "read-only",
    ]);
    expect(ids("opencode")).toEqual(["build", "plan"]);
    expect(ids("omp")).toEqual(["default", "plan"]);
    expect(ids("ama")).toEqual(["default", "auto-edit", "full-auto", "plan"]);
    // 没有可切的模式：不出选择，而不是出一个空的。
    expect(ids("pi")).toBeNull();
    expect(ids("copilot")).toBeNull();
    expect(ids("custom:unknown")).toBeNull();
  });

  it("starts on the node's permission mode, mapped to the agent's id", () => {
    expect(candidateModes("claude", "full-auto", name)?.currentModeId).toBe(
      "bypassPermissions",
    );
    expect(candidateModes("codex", "plan", name)?.currentModeId).toBe(
      "read-only",
    );
    expect(candidateModes("codex", undefined, name)?.currentModeId).toBe(
      "workspace-write",
    );
    // 只有启动旗标的模式（omp 的 yolo）会话里没有对应的 id：落回第一项。
    expect(candidateModes("omp", "full-auto", name)?.currentModeId).toBe(
      "default",
    );
  });

  it("names the modes through the caller, one name per permission mode", () => {
    expect(
      candidateModes("claude", undefined, name)?.availableModes.map(
        (m) => m.name,
      ),
    ).toEqual(["n:default", "n:auto-edit", "n:full-auto", "n:plan"]);
  });
});

describe("candidateModels", () => {
  it("always has the default entry and every built-in has some candidate", () => {
    for (const agent of AGENT_IDS) {
      const state = candidateModels(agent, undefined, "Default");
      expect(state.currentModelId, agent).toBe(DEFAULT_MODEL_ID);
      expect(state.availableModels[0], agent).toEqual({
        modelId: DEFAULT_MODEL_ID,
        name: "Default",
      });
    }
    expect(
      candidateModels("claude", undefined, "D").availableModels.map(
        (m) => m.modelId,
      ),
    ).toEqual([DEFAULT_MODEL_ID, "opus", "sonnet", "haiku"]);
  });

  it("puts the node's model first once, and makes it current", () => {
    const state = candidateModels("claude", "sonnet", "D");
    expect(state.currentModelId).toBe("sonnet");
    expect(state.availableModels.map((m) => m.modelId)).toEqual([
      DEFAULT_MODEL_ID,
      "sonnet",
      "opus",
      "haiku",
    ]);
    const own = candidateModels("opencode", "acme/x", "D");
    expect(own.availableModels.map((m) => m.modelId)).toEqual([
      DEFAULT_MODEL_ID,
      "acme/x",
    ]);
  });
});

describe("pickModes / pickModels", () => {
  const candidates = candidateModes("codex", undefined, name);
  const reported = {
    currentModeId: "read-only",
    availableModes: [
      { id: "read-only", name: "Read Only" },
      { id: "agent", name: "Agent" },
    ],
  };

  it("takes what the agent reported over the candidates", () => {
    expect(pickModes(reported, candidates, null)).toBe(reported);
    expect(pickModes(null, candidates, null)).toBe(candidates);
    expect(pickModes(null, null, "x")).toBeNull();
  });

  it("applies a choice only if the catalog has it", () => {
    expect(pickModes(reported, candidates, "agent")?.currentModeId).toBe(
      "agent",
    );
    // 候选里有、Agent 报回的没有：以 Agent 为准。
    expect(pickModes(reported, candidates, "agent-full-access")).toBe(reported);
    const models = candidateModels("claude", undefined, "D");
    expect(pickModels(null, models, "opus").currentModelId).toBe("opus");
    expect(pickModels(null, models, "gone")).toBe(models);
  });
});

describe("context meter", () => {
  const usage = { used: 10, size: 100 };

  it("waits for the first message to be sent", () => {
    expect(firstMessageSent([])).toBe(false);
    expect(visibleUsage(usage, [])).toBeNull();
    expect(visibleUsage(usage, [user(1, "hi")])).toBe(usage);
    expect(visibleUsage(null, [user(1, "hi")])).toBeNull();
  });

  it("does not count a message whose turn failed", () => {
    expect(visibleUsage(usage, [user(1, "hi"), turn(1, true)])).toBeNull();
    // 重试成功的那一轮算。
    expect(
      visibleUsage(usage, [
        user(1, "hi"),
        turn(1, true),
        user(2, "again"),
        turn(2),
      ]),
    ).toBe(usage);
  });
});
