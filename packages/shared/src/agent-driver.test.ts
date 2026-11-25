import { describe, expect, it } from "vitest";

import { AGENT_IDS } from "./agents";
import {
  DISCOVERED_TRANSCRIPT_AGENT_IDS,
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
        baseAgentId: "no-such-agent",
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

describe("a transcript that core has to go and find (agy)", () => {
  it("can be switched to the session body by hand but is not given it by default", () => {
    for (const id of DISCOVERED_TRANSCRIPT_AGENT_IDS) {
      expect(hasTranscript(id)).toBe(true);
      expect(
        defaultAgentView({
          setting: "acp",
          acpInstalled: false,
          baseAgentId: id,
        }),
      ).toEqual({ driver: "terminal" });
    }
    // 别的有转录的 CLI 照旧给会话体。
    expect(
      defaultAgentView({
        setting: "acp",
        acpInstalled: false,
        baseAgentId: "claude",
      }),
    ).toEqual({ driver: "terminal", view: "session" });
  });
});
