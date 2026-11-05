import { describe, expect, it } from "vitest";

import {
  ACP_CLI_FLOOR,
  AGENT_CLI_PACKAGES,
  AGENT_IDS,
  acpCliFloor,
  acpCliOutdated,
} from "../src/index";

/** 适配器对 CLI 本体的最低版本表（#710）。 */
describe("ACP_CLI_FLOOR", () => {
  it("only lists built-in agents and points at the package the installer installs", () => {
    for (const [id, floor] of Object.entries(ACP_CLI_FLOOR)) {
      expect(AGENT_IDS as readonly string[], id).toContain(id);
      expect(floor.package).toBe(
        AGENT_CLI_PACKAGES[id as keyof typeof AGENT_CLI_PACKAGES],
      );
      expect(floor.minVersion).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("pins pi at 1.1.0 on the current package, not the deprecated one", () => {
    expect(acpCliFloor("pi")).toEqual({
      minVersion: "1.1.0",
      package: "@earendil-works/pi-coding-agent",
    });
    expect(AGENT_CLI_PACKAGES.pi).not.toContain("mariozechner");
  });

  it("has no floor for agents that were not measured", () => {
    expect(acpCliFloor("claude")).toBeUndefined();
    expect(acpCliFloor("custom:pi")).toBeUndefined();
  });
});

describe("acpCliOutdated", () => {
  it("reports an installed version below the floor", () => {
    expect(acpCliOutdated("pi", "1.0.4")).toEqual({
      agentId: "pi",
      installed: "1.0.4",
      minimum: "1.1.0",
      package: "@earendil-works/pi-coding-agent",
    });
    expect(acpCliOutdated("pi", "0.80.10")?.installed).toBe("0.80.10");
  });

  it("passes the floor itself and anything above, comparing per segment", () => {
    expect(acpCliOutdated("pi", "1.1.0")).toBeUndefined();
    expect(acpCliOutdated("pi", "1.10.0")).toBeUndefined();
    expect(acpCliOutdated("pi", "1.5.0")).toBeUndefined();
  });

  it("does not block when the version could not be read or no floor exists", () => {
    expect(acpCliOutdated("pi", null)).toBeUndefined();
    expect(acpCliOutdated("pi", "")).toBeUndefined();
    expect(acpCliOutdated("pi", "unknown")).toBeUndefined();
    expect(acpCliOutdated("claude", "0.0.1")).toBeUndefined();
  });
});
