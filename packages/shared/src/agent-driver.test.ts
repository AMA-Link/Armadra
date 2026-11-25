import { describe, expect, it } from "vitest";

import { AGENT_IDS } from "./agents";
import {
  TRANSCRIPT_AGENT_IDS,
  hasTranscript,
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

  // The list itself is matched to the registered adapters in
  // `core/collab/node-driver.test.ts`; here it is only held to the registry.
  it("lists only built-in base agents, and hasTranscript agrees with it", () => {
    for (const id of TRANSCRIPT_AGENT_IDS) {
      expect(AGENT_IDS as readonly string[], id).toContain(id);
    }
    for (const id of AGENT_IDS) {
      expect(hasTranscript(id), id).toBe(
        (TRANSCRIPT_AGENT_IDS as readonly string[]).includes(id),
      );
    }
    expect(hasTranscript("custom:x")).toBe(false);
  });
});
