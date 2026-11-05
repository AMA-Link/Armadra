import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ACP_MODE_TABLE, acpModeCandidates } from "@armadra/shared";

import { PERMISSION_MODES, launchProfile } from "../agent/launch";
import { AGENT_IDS } from "../agent/registry";
import {
  ACP_ADAPTERS,
  type AcpAdapter,
  acpAdapter,
  acpLaunchPlan,
  acpPermissionModes,
} from "./adapters";

/**
 * 适配器表（ACP 会话视图设计 §5.2）。表本身是数据，这里守的是它与别处的
 * 一致：模式集合与 `permissionFlag` 相同、一家一行、程序名与发布兼容表对齐。
 */

describe("ACP_ADAPTERS", () => {
  it("has one row per built-in agent plus ama, and nothing else", () => {
    const ids = ACP_ADAPTERS.map((adapter) => adapter.agentId);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...new Set([...AGENT_IDS, "ama"])].sort());
  });

  it("covers exactly the permission modes permissionFlag covers", () => {
    for (const adapter of ACP_ADAPTERS) {
      const modes = Object.keys(adapter.modes).sort();
      expect(modes, adapter.agentId).toEqual([...PERMISSION_MODES].sort());
      // ama 的终端启动配置由 G1-7 补进 core；补上之后同一条也守着它。
      const profile = launchProfile(adapter.agentId);
      if (profile !== undefined) {
        expect(modes, adapter.agentId).toEqual(
          Object.keys(profile.permissionFlag).sort(),
        );
      }
    }
  });

  it("takes its modes from the shared compatibility table", () => {
    for (const adapter of ACP_ADAPTERS) {
      expect(adapter.modes, adapter.agentId).toBe(
        ACP_MODE_TABLE[adapter.agentId as keyof typeof ACP_MODE_TABLE],
      );
      // 页面在 Agent 报回之前给的候选，都是这家 ACP 下真有落点的模式。
      const offered = acpPermissionModes(adapter);
      for (const candidate of acpModeCandidates(adapter.agentId)) {
        expect(offered, adapter.agentId).toContain(candidate.permissionMode);
        expect(
          acpLaunchPlan(adapter, { mode: candidate.permissionMode }),
        ).toMatchObject({
          modeId: candidate.modeId,
        });
      }
    }
  });

  it("always offers default, and only modes that land somewhere", () => {
    for (const adapter of ACP_ADAPTERS) {
      expect(adapter.modes.default, adapter.agentId).not.toBeNull();
      for (const mode of acpPermissionModes(adapter)) {
        const mapping = adapter.modes[mode];
        expect(mapping, `${adapter.agentId} ${mode}`).not.toBeNull();
        if (mode !== "default") {
          expect(
            mapping?.modeId !== undefined || (mapping?.args?.length ?? 0) > 0,
            `${adapter.agentId} ${mode}`,
          ).toBe(true);
        }
      }
    }
    expect(acpPermissionModes(acpAdapter("opencode")!)).toEqual([
      "default",
      "plan",
    ]);
    expect(acpPermissionModes(acpAdapter("pi")!)).toEqual([
      "default",
      "auto-edit",
      "full-auto",
      "plan",
    ]);
  });

  it("follows the design's resume and session-id rules", () => {
    const rule = (id: string) => {
      const adapter = acpAdapter(id)!;
      return [adapter.support, adapter.sessionId, adapter.resume];
    };
    expect(rule("claude")).toEqual(["official", "same", "load"]);
    expect(rule("codex")).toEqual(["official", "same", "load"]);
    expect(rule("opencode")).toEqual(["native", "same", "load"]);
    expect(rule("pi")).toEqual(["bundled", "same", "load"]);
    expect(rule("omp")).toEqual(["native", "same", "load"]);
    // Copilot 跨进程不可接回，所以永不休眠。
    expect(rule("copilot")).toEqual(["native", "opaque", "none"]);
    expect(rule("ama")).toEqual(["native", "same", "resume"]);
    // ama 的画布工具走 profile 的 host 适配器，不带；其余六家（含 pi 的桥）都带
    // （契约 §48）。
    for (const adapter of ACP_ADAPTERS) {
      expect(adapter.injection.mcp, adapter.agentId).toBe(
        adapter.agentId !== "ama",
      );
    }
  });

  it("canvasTools: mcp exactly when MCP is injected; ama runners", () => {
    for (const adapter of ACP_ADAPTERS) {
      expect(adapter.canvasTools === "mcp", adapter.agentId).toBe(
        adapter.injection.mcp,
      );
    }
    expect(acpAdapter("ama")?.canvasTools).toBe("runners");
    expect(acpAdapter("pi")?.canvasTools).toBe("mcp");
  });

  it("names the same programs as the release compatibility table", () => {
    const file = join(
      __dirname,
      "../../../../../tools/release/compatibility.json",
    );
    const acp = JSON.parse(readFileSync(file, "utf8")).acp as {
      protocolVersion: number;
      adapters: Record<string, { program: string }>;
    };
    expect(acp.protocolVersion).toBe(1);
    expect(
      Object.fromEntries(
        Object.entries(acp.adapters).map(([id, entry]) => [id, entry.program]),
      ),
    ).toEqual(
      Object.fromEntries(ACP_ADAPTERS.map((a) => [a.agentId, a.program])),
    );
  });
});

describe("acpLaunchPlan", () => {
  it("puts a mode id on set_mode and nothing on the argv", () => {
    expect(acpLaunchPlan(acpAdapter("claude")!, { mode: "auto-edit" })).toEqual(
      { args: [], modeId: "acceptEdits" },
    );
    expect(acpLaunchPlan(acpAdapter("codex")!)).toEqual({
      args: [],
      modeId: "workspace-write",
    });
  });

  it("puts a flag mode on the argv after the fixed words", () => {
    expect(acpLaunchPlan(acpAdapter("omp")!, { mode: "full-auto" })).toEqual({
      args: ["acp", "--approval-mode", "yolo"],
    });
    expect(acpLaunchPlan(acpAdapter("copilot")!, { mode: "plan" })).toEqual({
      args: ["--acp", "--stdio", "--plan"],
    });
  });

  it("refuses a mode with no mapping instead of starting writable", () => {
    expect(
      acpLaunchPlan(acpAdapter("opencode")!, { mode: "full-auto" }),
    ).toEqual(expect.objectContaining({ code: "acp_mode_unsupported" }));
  });

  it("adds ama's profile and reuses only the injection the adapter can take", () => {
    expect(
      acpLaunchPlan(acpAdapter("ama")!, {
        mode: "plan",
        profilePath: "/data/ama/profile.json",
        injectionArgs: ["--ignored"],
      }),
    ).toEqual({
      args: ["--mode", "acp", "--profile", "/data/ama/profile.json"],
      modeId: "plan",
    });
    expect(
      acpLaunchPlan(acpAdapter("ama")!, {
        profilePath: "/data/ama/profile.json",
        role: "coordinator",
      }),
    ).toEqual({
      args: [
        "--mode",
        "acp",
        "--profile",
        "/data/ama/profile.json",
        "--tools-preset",
        "coordinator",
      ],
      modeId: "default",
    });
    expect(
      acpLaunchPlan(acpAdapter("codex")!, { role: "coordinator" }),
    ).toEqual({
      args: [],
      modeId: "workspace-write",
    });
    expect(
      acpLaunchPlan(acpAdapter("opencode")!, { injectionArgs: ["--nope"] }),
    ).toEqual({ args: ["acp"], modeId: "build" });
  });
});

describe("pi's bridge (AMA-Link/Armadra#716)", () => {
  const pi = acpAdapter("pi") as AcpAdapter;

  it("is the bundled ama's `--bridge pi`, with Pi's own session id", () => {
    expect(pi.program).toBe("ama");
    expect(pi.args).toEqual(["--mode", "acp", "--bridge", "pi"]);
    expect(pi.support).toBe("bundled");
    expect(pi.sessionId).toBe("same");
    expect(pi.expectedProcess).toEqual(["ama", "ama.cjs"]);
    expect(pi).not.toHaveProperty("profileFlag");
  });

  it("offers all four modes by the bridge's ids, applied with set_mode", () => {
    expect(acpPermissionModes(pi)).toEqual([
      "default",
      "auto-edit",
      "full-auto",
      "plan",
    ]);
    for (const mode of ["default", "auto-edit", "full-auto", "plan"] as const) {
      expect(acpLaunchPlan(pi, { mode })).toEqual({
        args: ["--mode", "acp", "--bridge", "pi"],
        modeId: mode,
      });
    }
  });

  it("passes the injection to Pi after `--`, never ama's profile", () => {
    expect(
      acpLaunchPlan(pi, {
        profilePath: "/data/ama/profile.json",
        injectionArgs: ["--skill", "/x/armadra"],
      }),
    ).toEqual({
      args: ["--mode", "acp", "--bridge", "pi", "--", "--skill", "/x/armadra"],
      modeId: "default",
    });
  });
});
