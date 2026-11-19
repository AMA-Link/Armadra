import { describe, expect, it } from "vitest";

import {
  BARE_LAUNCH_ENV,
  bareLaunchOf,
  supportsBareLaunch,
} from "./agent-bare-launch.js";
import { completionSettingsSchema } from "./api/settings.js";

describe("bareLaunchOf", () => {
  it("is off by default and for anything that is not literally true", () => {
    expect(bareLaunchOf({}, "claude")).toBe(false);
    expect(bareLaunchOf(undefined, "claude")).toBe(false);
    expect(bareLaunchOf({ agents: { claude: {} } }, "claude")).toBe(false);
    expect(
      bareLaunchOf({ agents: { claude: { bareLaunch: "yes" } } }, "claude"),
    ).toBe(false);
  });

  it("reads the per-agent flag", () => {
    const settings = { agents: { claude: { bareLaunch: true } } };
    expect(bareLaunchOf(settings, "claude")).toBe(true);
    expect(bareLaunchOf(settings, "codex")).toBe(false);
  });

  it("only applies to injected built-ins", () => {
    const settings = { agents: { "custom:x": { bareLaunch: true } } };
    expect(bareLaunchOf(settings, "custom:x")).toBe(false);
    expect(supportsBareLaunch("claude")).toBe(true);
    expect(supportsBareLaunch("custom:x")).toBe(false);
    expect(supportsBareLaunch("custom")).toBe(false);
    expect(BARE_LAUNCH_ENV).toBe("ARMADRA_BARE");
  });
});

describe("settings schema", () => {
  it("keeps a boolean flag and snaps anything else back to false", () => {
    const parsed = completionSettingsSchema.parse({
      agents: {
        claude: { bareLaunch: true },
        codex: { bareLaunch: "no" },
        opencode: {},
      },
    });
    const agents = parsed.agents as Record<string, { bareLaunch: boolean }>;
    expect(agents.claude?.bareLaunch).toBe(true);
    expect(agents.codex?.bareLaunch).toBe(false);
    expect(agents.opencode?.bareLaunch).toBe(false);
  });

  it("does not add entries for agents that were never written", () => {
    const parsed = completionSettingsSchema.parse({});
    expect("claude" in parsed.agents).toBe(false);
  });
});
