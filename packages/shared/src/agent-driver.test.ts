import { describe, expect, it } from "vitest";

import { defaultAgentDriver } from "./agent-driver";

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
  });
});
