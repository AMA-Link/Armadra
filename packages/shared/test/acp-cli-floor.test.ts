import { describe, expect, it } from "vitest";

import {
  ACP_CLI_FLOOR,
  AGENT_CLI_PACKAGES,
  AGENT_IDS,
  acpCliFloor,
  acpCliOutdated,
  floorHint,
  parseCliVersion,
} from "../src/index";

/** 适配器对 CLI 本体的最低版本表（#710）。 */
describe("ACP_CLI_FLOOR", () => {
  it("only lists built-in agents and points at the package the installer installs", () => {
    for (const [id, floor] of Object.entries(ACP_CLI_FLOOR)) {
      expect(AGENT_IDS as readonly string[], id).toContain(id);
      // 下限指向安装器装的那个包；两边都没有包也算相等，此时必须给升级命令，
      // 否则过旧的提示没有一句可说。
      const installed =
        AGENT_CLI_PACKAGES[id as keyof typeof AGENT_CLI_PACKAGES];
      expect(floor.package, id).toBe(installed);
      if (floor.package === undefined) {
        expect(floor.updateCommand, id).toEqual(expect.any(String));
      }
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

  it("pins agy at 1.5.15 and points at its own updater, not an npm package", () => {
    expect(acpCliFloor("agy")).toEqual({
      minVersion: "1.5.15",
      updateCommand: "agy update",
    });
    expect(acpCliOutdated("agy", "1.5.14")).toEqual({
      agentId: "agy",
      installed: "1.5.14",
      minimum: "1.5.15",
      updateCommand: "agy update",
    });
    expect(acpCliOutdated("agy", "1.5.16")).toBeUndefined();
    expect(AGENT_CLI_PACKAGES).not.toHaveProperty("agy");
  });

  it("pins grok at 1.0.92, where its ACP entry was measured, on its npm package", () => {
    expect(acpCliFloor("grok")).toEqual({
      minVersion: "1.0.92",
      package: "@xai-official/grok",
    });
    // `grok --version` 的整行：版本在前，后面的提交哈希与通道不能被读成版本。
    expect(parseCliVersion("grok 1.0.92 (b06756fd6256) [alpha]")).toBe(
      "1.0.92",
    );
    expect(parseCliVersion("grok 1.0.77 (50ca579fa996) [stable]")).toBe(
      "1.0.77",
    );
    expect(acpCliOutdated("grok", "1.0.77")).toMatchObject({
      installed: "1.0.77",
      minimum: "1.0.92",
      package: "@xai-official/grok",
    });
    expect(acpCliOutdated("grok", "1.0.92")).toBeUndefined();
    expect(acpCliOutdated("grok", "1.1.0")).toBeUndefined();
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

describe("floorHint", () => {
  it("carries the package, the update command, or neither", () => {
    expect(floorHint({ minVersion: "1.0.0", package: "pkg" })).toEqual({
      package: "pkg",
    });
    expect(
      floorHint({ minVersion: "1.0.0", updateCommand: "tool update" }),
    ).toEqual({ updateCommand: "tool update" });
    expect(floorHint({ minVersion: "1.0.0" })).toEqual({});
  });
});
