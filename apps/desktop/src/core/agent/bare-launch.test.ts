import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../testing/temp-dir";
import { canvasEnvironment } from "./canvas-launch";
import type { AgentSettings } from "./registry";

/** 节点环境只在设置打开时带 `ARMADRA_BARE=1`（契约 §113，#975）。 */

function settingsWith(bare: readonly string[]): AgentSettings {
  return {
    customAgents: () => [],
    bareLaunch: (agentId) => bare.includes(agentId),
  };
}

function dataDir(): string {
  const dir = join(tempDir("armadra-bare-env-"), "data");
  mkdirSync(dir, { recursive: true });
  return dir;
}

const names = (env: readonly (readonly [string, string])[]) =>
  env.map(([name]) => name);

describe("canvasEnvironment with the zero-injection switch", () => {
  it("adds ARMADRA_BARE=1 only for the agent whose switch is on", () => {
    const dir = dataDir();
    const settings = settingsWith(["claude"]);
    const on = canvasEnvironment(settings, dir, "claude");
    expect(on).toContainEqual(["ARMADRA_BARE", "1"]);
    // 垫片与 PATH 照旧：手敲的 CLI 仍经启动器，由它看见变量后原样启动。
    expect(names(on)).toEqual(
      expect.arrayContaining(["ARMADRA_SHIMS", "PATH"]),
    );
    expect(names(canvasEnvironment(settings, dir, "codex"))).not.toContain(
      "ARMADRA_BARE",
    );
  });

  it("leaves the environment unchanged when the switch is off or absent", () => {
    const dir = dataDir();
    const off = canvasEnvironment(settingsWith([]), dir, "claude");
    const absent = canvasEnvironment({ customAgents: () => [] }, dir, "claude");
    expect(names(off)).toEqual(["ARMADRA_SHIMS", "PATH"]);
    expect(absent).toEqual(off);
  });

  it("forwards it for an SSH node and ignores CLIs without an injection", () => {
    const dir = dataDir();
    const settings = settingsWith(["claude", "gemini"]);
    expect(
      canvasEnvironment(settings, dir, "claude", undefined, { ssh: true }),
    ).toEqual([["ARMADRA_BARE", "1"]]);
    expect(canvasEnvironment(settings, dir, "gemini")).toEqual([]);
  });
});
