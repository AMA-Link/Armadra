import { describe, expect, it } from "vitest";

import {
  ACP_MODE_TABLE,
  ACP_REPORTED_MODES,
  AGENT_IDS,
  PERMISSION_MODES,
  acpModeCandidates,
  acpModeIdOf,
  acpReportsPermissionModes,
  agentDefinition,
  permissionModeOfAcpMode,
} from "../src/index";

/**
 * ACP 权限模式兼容表（#685）：一家一行，覆盖的模式集合与终端启动旗标一致，
 * 每家会话里能切的候选（含 bypass 一类的全自动）逐家写死在这里。
 */
describe("ACP_MODE_TABLE", () => {
  it("has one row per built-in agent, covering every permission mode", () => {
    expect(Object.keys(ACP_MODE_TABLE).sort()).toEqual([...AGENT_IDS].sort());
    for (const id of AGENT_IDS) {
      expect(Object.keys(ACP_MODE_TABLE[id]).sort(), id).toEqual(
        [...PERMISSION_MODES].sort(),
      );
      // 终端有旗标的模式，ACP 下必须有落点（反过来不必：opencode 的 plan 是
      // agent 名，终端没有对应旗标）；`default` 总在。
      const definition = agentDefinition(id);
      for (const mode of PERMISSION_MODES) {
        if ((definition?.permissionFlag[mode].length ?? 0) > 0) {
          expect(ACP_MODE_TABLE[id][mode], `${id} ${mode}`).not.toBe(null);
        }
      }
      expect(ACP_MODE_TABLE[id].default, id).not.toBe(null);
    }
  });

  it("lists, per agent, the modes a live session can switch to", () => {
    const table = Object.fromEntries(
      AGENT_IDS.map((id) => [
        id,
        acpModeCandidates(id).map((c) => `${c.permissionMode}=${c.modeId}`),
      ]),
    );
    // Every built-in has an entry here or says why not; an agent added later
    // writes its own row below rather than reshaping this one.
    expect(Object.keys(table)).toEqual([...AGENT_IDS]);
    const expected: Record<string, string[]> = {
      claude: [
        "default=default",
        "auto-edit=acceptEdits",
        "full-auto=bypassPermissions",
        "plan=plan",
      ],
      codex: [
        "default=workspace-write",
        "auto-edit=agent",
        "full-auto=agent-full-access",
        "plan=read-only",
      ],
      opencode: ["default=build", "plan=plan"],
      pi: [
        "default=default",
        "auto-edit=auto-edit",
        "full-auto=full-auto",
        "plan=plan",
      ],
      omp: ["default=default", "plan=plan"],
      copilot: [],
      ama: [
        "default=default",
        "auto-edit=auto-edit",
        "full-auto=full-auto",
        "plan=plan",
      ],
      // Measured on agy 1.5.16: `auto` is not a no-approval mode, so
      // `full-auto` is a launch flag with no session mode id.
      agy: ["default=default", "auto-edit=accept-edits", "plan=plan"],
    };
    for (const [id, candidates] of Object.entries(expected)) {
      expect(table[id], id).toEqual(candidates);
    }
  });

  it("offers a bypass-style mode wherever the agent has a switchable one", () => {
    const withBypass = AGENT_IDS.filter((id) =>
      acpModeCandidates(id).some((c) => c.permissionMode === "full-auto"),
    );
    expect(withBypass).toEqual(
      expect.arrayContaining(["claude", "codex", "pi", "ama"]),
    );
    expect(withBypass).not.toContain("opencode");
    expect(withBypass).not.toContain("omp");
    expect(withBypass).not.toContain("copilot");
    expect(withBypass).not.toContain("agy");
    expect(ACP_MODE_TABLE.agy["full-auto"]?.args).toEqual([
      "--dangerously-skip-permissions",
    ]);
    // 其余只在启动旗标上有（omp、copilot）或根本没有（opencode）。
    expect(ACP_MODE_TABLE.omp["full-auto"]?.args).toEqual([
      "--approval-mode",
      "yolo",
    ]);
    expect(ACP_MODE_TABLE.copilot["full-auto"]?.args).toEqual([
      "--allow-all-tools",
    ]);
    expect(ACP_MODE_TABLE.opencode["full-auto"]).toBe(null);
  });

  it("maps between permission modes and session mode ids", () => {
    expect(acpModeIdOf("claude", "full-auto")).toBe("bypassPermissions");
    expect(permissionModeOfAcpMode("codex", "agent-full-access")).toBe(
      "full-auto",
    );
    expect(acpModeIdOf("copilot", "full-auto")).toBeUndefined();
    expect(permissionModeOfAcpMode("claude", "nope")).toBeUndefined();
    expect(acpModeIdOf("custom:x", "default")).toBeUndefined();
    expect(acpModeCandidates("custom:x")).toEqual([]);
  });
});

describe("ACP_REPORTED_MODES", () => {
  it("has one row per built-in agent and every one reports permission modes", () => {
    expect(Object.keys(ACP_REPORTED_MODES).sort()).toEqual(
      [...AGENT_IDS].sort(),
    );
    const ignored = AGENT_IDS.filter((id) => !acpReportsPermissionModes(id));
    expect(ignored).toEqual([]);
  });

  it("treats an unknown or custom agent as reporting permission modes", () => {
    expect(acpReportsPermissionModes("custom:x")).toBe(true);
  });
});
