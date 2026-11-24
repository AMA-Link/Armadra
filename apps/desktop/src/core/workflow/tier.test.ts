import { describe, expect, it } from "vitest";
import type { AgentSettings } from "../agent/registry";
import { roleLaunch, tierHints, tierModel } from "./tier";
import type { WorkflowDraft, WorkflowRole } from "./types";

const settings: AgentSettings = {
  customAgents: () =>
    [{ id: "custom:mine", baseAgent: "claude" }] as unknown as ReturnType<
      AgentSettings["customAgents"]
    >,
};

const role = (
  extra: Partial<WorkflowRole> & { agentId: string },
): WorkflowRole => ({
  id: "r",
  ...extra,
});

describe("tierModel", () => {
  it("only claude has a built-in table", () => {
    expect(tierModel("claude", "light")).toBe("haiku");
    expect(tierModel("claude", "standard")).toBe("sonnet");
    expect(tierModel("claude", "strong")).toBe("opus");
    expect(tierModel("claude", "max")).toBe("opus");
    expect(tierModel("codex", "strong")).toBeUndefined();
    expect(tierModel("ama", "strong")).toBeUndefined();
  });
});

describe("roleLaunch", () => {
  it("lets an explicit model win, and does nothing without a tier", () => {
    expect(
      roleLaunch(
        settings,
        role({ agentId: "claude", model: "x", tier: "max" }),
        true,
      ),
    ).toEqual({ model: "x", tier: null, effect: null });
    expect(roleLaunch(settings, role({ agentId: "claude" }), true)).toEqual({
      model: null,
      tier: null,
      effect: null,
    });
  });

  it("ama: native when the probed version supports it, otherwise ignored", () => {
    const r = role({ agentId: "ama", tier: "strong" });
    expect(roleLaunch(settings, r, true)).toEqual({
      model: null,
      tier: "strong",
      effect: "native",
    });
    expect(roleLaunch(settings, r, false).effect).toBe("ignored");
  });

  it("claude (and a custom entry on it): mapped to an alias", () => {
    expect(
      roleLaunch(settings, role({ agentId: "claude", tier: "light" }), false),
    ).toEqual({ model: "haiku", tier: null, effect: "mapped" });
    expect(
      roleLaunch(
        settings,
        role({ agentId: "custom:mine", tier: "max" }),
        false,
      ),
    ).toMatchObject({ model: "opus", effect: "mapped" });
  });

  it("other CLIs ignore the tier", () => {
    expect(
      roleLaunch(settings, role({ agentId: "codex", tier: "strong" }), true),
    ).toEqual({ model: null, tier: null, effect: "ignored" });
  });
});

describe("tierHints", () => {
  it("lists the roles whose tier has no effect", () => {
    const draft: WorkflowDraft = {
      version: 2,
      title: "t",
      params: [],
      roles: [
        { id: "a", agentId: "claude", tier: "light" },
        { id: "b", agentId: "codex", tier: "strong" },
        { id: "c", agentId: "ama", tier: "max" },
        { id: "d", agentId: "codex", tier: "strong", model: "m" },
        { id: "e", agentId: "codex" },
      ],
      links: [],
      steps: [],
    };
    expect(tierHints(settings, draft, true)).toEqual(["b"]);
    expect(tierHints(settings, draft, false)).toEqual(["b", "c"]);
  });
});
