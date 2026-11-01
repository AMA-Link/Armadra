import { describe, expect, it } from "vitest";

import {
  ACP_MODE_TABLE,
  AGENT_IDS,
  PERMISSION_MODES,
  acpModeCandidates,
  acpModeIdOf,
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
    expect(table).toEqual({
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
      pi: [],
      omp: ["default=default", "plan=plan"],
      copilot: [],
      ama: [
        "default=default",
        "auto-edit=auto-edit",
        "full-auto=full-auto",
        "plan=plan",
      ],
    });
  });

  it("offers a bypass-style mode wherever the agent has a switchable one", () => {
    const withBypass = AGENT_IDS.filter((id) =>
      acpModeCandidates(id).some((c) => c.permissionMode === "full-auto"),
    );
    expect(withBypass).toEqual(["claude", "codex", "ama"]);
    // 其余只在启动旗标上有（omp、copilot）或根本没有（opencode、pi）。
    expect(ACP_MODE_TABLE.omp["full-auto"]?.args).toEqual([
      "--approval-mode",
      "yolo",
    ]);
    expect(ACP_MODE_TABLE.copilot["full-auto"]?.args).toEqual([
      "--allow-all-tools",
    ]);
    expect(ACP_MODE_TABLE.opencode["full-auto"]).toBe(null);
    expect(ACP_MODE_TABLE.pi["full-auto"]).toBe(null);
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
