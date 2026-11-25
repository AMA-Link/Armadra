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
  acpSessionMeta,
  systemPromptAppendMeta,
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
    // agy：ACP sessionId 就是 CLI 的会话 id（对话库文件名），load 与 resume 都声明。
    expect(rule("agy")).toEqual(["native", "same", "load"]);
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

  it("maps agy's modes as measured: three session modes, full-auto a flag", () => {
    const agy = acpAdapter("agy")!;
    expect(agy.program).toBe("agy");
    expect(acpLaunchPlan(agy)).toEqual({ args: ["acp"], modeId: "default" });
    expect(acpLaunchPlan(agy, { mode: "auto-edit" })).toEqual({
      args: ["acp"],
      modeId: "accept-edits",
    });
    expect(acpLaunchPlan(agy, { mode: "plan" })).toEqual({
      args: ["acp"],
      modeId: "plan",
    });
    // `auto` is not "no approvals": the bypass is the launch flag, no modeId.
    expect(acpLaunchPlan(agy, { mode: "full-auto" })).toEqual({
      args: ["acp", "--dangerously-skip-permissions"],
    });
    expect(acpPermissionModes(agy)).toEqual([
      "default",
      "auto-edit",
      "full-auto",
      "plan",
    ]);
    // Canvas tools ride session/new.mcpServers; the instructions wait for
    // `_meta` (armadra-agent#327), so the row has no `sessionMeta`.
    expect(agy.injection).toEqual({ mcp: true, reuse: [] });
    expect(agy.canvasTools).toBe("mcp");
    expect(agy.sessionMeta).toBeUndefined();
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

describe("session _meta", () => {
  const base = acpAdapter("claude") as AcpAdapter;

  it("is absent on every built-in row today", () => {
    for (const adapter of ACP_ADAPTERS) {
      expect(adapter.sessionMeta, adapter.agentId).toBeUndefined();
      expect(
        acpSessionMeta(adapter, { mode: "default", instructions: "x" }),
        adapter.agentId,
      ).toBeUndefined();
    }
  });

  it("puts a system prompt under the vendor's own namespace, or nothing", () => {
    expect(systemPromptAppendMeta("vendor", "rules")).toEqual({
      vendor: { systemPrompt: { append: "rules" } },
    });
    expect(systemPromptAppendMeta("vendor", undefined)).toBeUndefined();
    expect(systemPromptAppendMeta("vendor", "  \n")).toBeUndefined();
  });

  it("hands the adapter the mode, the instructions and the plugin dirs", () => {
    const seen: unknown[] = [];
    const adapter: AcpAdapter = {
      ...base,
      sessionMeta: (input) => {
        seen.push(input);
        return { vendor: { yolo: input.mode === "full-auto" } };
      },
    };
    expect(
      acpSessionMeta(adapter, {
        mode: "full-auto",
        instructions: "r",
        pluginDirs: ["/p"],
      }),
    ).toEqual({ vendor: { yolo: true } });
    expect(seen).toEqual([
      { mode: "full-auto", instructions: "r", pluginDirs: ["/p"] },
    ]);
  });

  it("drops empty namespaces and empty answers, so the wire does not change", () => {
    const answer = (
      value: Record<string, unknown> | undefined,
    ): AcpAdapter => ({
      ...base,
      sessionMeta: () => value,
    });
    const input = { mode: "default" as const };
    expect(acpSessionMeta(answer(undefined), input)).toBeUndefined();
    expect(acpSessionMeta(answer({}), input)).toBeUndefined();
    expect(acpSessionMeta(answer({ vendor: {} }), input)).toBeUndefined();
    expect(
      acpSessionMeta(
        answer({ vendor: {}, other: { a: 1 }, gone: null }),
        input,
      ),
    ).toEqual({ other: { a: 1 } });
  });
});

describe("grok 的启动 argv", () => {
  const grok = acpAdapter("grok") as AcpAdapter;

  it("`stdio` 子命令永远排在最后，模式旗标在它之前", () => {
    expect(acpLaunchPlan(grok)).toEqual({
      args: ["agent", "--no-leader", "stdio"],
      trailingArgs: ["stdio"],
      modeId: "default",
    });
    expect(acpLaunchPlan(grok, { mode: "full-auto" })).toEqual({
      args: ["agent", "--no-leader", "--always-approve", "stdio"],
      trailingArgs: ["stdio"],
    });
    expect(acpLaunchPlan(grok, { mode: "plan" })).toEqual({
      args: ["agent", "--no-leader", "stdio"],
      trailingArgs: ["stdio"],
      modeId: "plan",
    });
  });

  it("调用方的 extraArgs（如 MCP 启动参数）在注入之后、stdio 之前", () => {
    const plan = acpLaunchPlan(
      { ...grok, injection: { mcp: true, reuse: ["args"] } },
      {
        mode: "full-auto",
        injectionArgs: ["--plugin-dir", "/x"],
        extraArgs: ["--mcp", "a"],
      },
    ) as { args: string[] };
    expect(plan.args).toEqual([
      "agent",
      "--no-leader",
      "--always-approve",
      "--plugin-dir",
      "/x",
      "--mcp",
      "a",
      "stdio",
    ]);
    // 没有 trailingArgs 的家：extraArgs 就在最后，与以前 `plan.args + mcpArgs` 相同。
    const copilot = acpLaunchPlan(acpAdapter("copilot") as AcpAdapter, {
      extraArgs: ["--additional-mcp-config", "@x"],
    }) as { args: string[]; trailingArgs?: string[] };
    expect(copilot.args).toEqual([
      "--acp",
      "--stdio",
      "--additional-mcp-config",
      "@x",
    ]);
    expect(copilot.trailingArgs).toBeUndefined();
  });

  it("injection 的 argv 也排在 stdio 之前", () => {
    const plan = acpLaunchPlan(
      {
        ...grok,
        injection: { mcp: true, reuse: ["args"] },
      },
      {
        mode: "full-auto",
        injectionArgs: ["--plugin-dir", "/x"],
      },
    ) as { args: string[] };
    expect(plan.args).toEqual([
      "agent",
      "--no-leader",
      "--always-approve",
      "--plugin-dir",
      "/x",
      "stdio",
    ]);
  });

  it("auto-edit 在 ACP 下没有落点：报错，不悄悄用缺省", () => {
    expect(acpLaunchPlan(grok, { mode: "auto-edit" })).toMatchObject({
      code: "acp_mode_unsupported",
    });
    expect(acpPermissionModes(grok)).toEqual(["default", "full-auto", "plan"]);
  });

  it("别家没有 trailingArgs，argv 不变", () => {
    for (const adapter of ACP_ADAPTERS) {
      if (adapter.agentId === "grok") continue;
      expect(adapter.trailingArgs, adapter.agentId).toBeUndefined();
    }
    expect(acpLaunchPlan(acpAdapter("copilot") as AcpAdapter)).toMatchObject({
      args: ["--acp", "--stdio"],
    });
  });

  it("画布工具走 mcp，会话 id 同一个，用 session/load 接回", () => {
    expect(grok).toMatchObject({
      canvasTools: "mcp",
      sessionId: "same",
      resume: "load",
      injection: { mcp: true },
    });
  });
});
