import { describe, expect, it } from "vitest";

import {
  TRANSCRIPT_AGENT_IDS,
  defaultAgentDriver,
  defaultAgentView,
} from "./agent-driver";

describe("defaultAgentDriver", () => {
  it("is acp only when the setting says so and the adapter is installed", () => {
    expect(defaultAgentDriver({ setting: "acp", acpInstalled: true })).toBe(
      "acp",
    );
    expect(defaultAgentDriver({ setting: "acp", acpInstalled: false })).toBe(
      "terminal",
    );
    expect(
      defaultAgentDriver({ setting: "terminal", acpInstalled: true }),
    ).toBe("terminal");
    expect(
      defaultAgentDriver({
        setting: "acp",
        acpInstalled: true,
        ownLaunch: true,
      }),
    ).toBe("terminal");
  });
});

describe("defaultAgentView", () => {
  const base = { acpInstalled: true, baseAgentId: "claude" };

  it("preference terminal: terminal driver, terminal body", () => {
    expect(defaultAgentView({ ...base, setting: "terminal" })).toEqual({
      driver: "terminal",
    });
    expect(
      defaultAgentView({
        setting: "terminal",
        acpInstalled: false,
        baseAgentId: "codex",
      }),
    ).toEqual({ driver: "terminal" });
  });

  it("preference session: acp when the adapter is installed", () => {
    expect(defaultAgentView({ ...base, setting: "acp" })).toEqual({
      driver: "acp",
    });
  });

  it("preference session without acp: terminal driver, session body when a transcript adapter exists", () => {
    expect(
      defaultAgentView({ ...base, setting: "acp", acpInstalled: false }),
    ).toEqual({ driver: "terminal", view: "session" });
    expect(
      defaultAgentView({ ...base, setting: "acp", ownLaunch: true }),
    ).toEqual({ driver: "terminal", view: "session" });
  });

  it("preference session with neither: terminal body", () => {
    expect(
      defaultAgentView({
        setting: "acp",
        acpInstalled: false,
        baseAgentId: "grok",
      }),
    ).toEqual({ driver: "terminal" });
  });

  it("lists the base agents that have transcript adapters", () => {
    expect([...TRANSCRIPT_AGENT_IDS].sort()).toEqual(
      ["ama", "claude", "codex", "copilot", "omp", "opencode", "pi"].sort(),
    );
  });
});
