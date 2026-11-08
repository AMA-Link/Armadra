import {
  ACP_MODE_TABLE,
  type AcpModeMapping,
  type AgentRole,
  roleFlags,
} from "@armadra/shared";

import { type PermissionMode, PERMISSION_MODES } from "../agent/launch";
import {
  type AgentId,
  type AgentSettings,
  baseAgent,
  customAgent,
} from "../agent/registry";

/**
 * 七家 Agent 以 ACP 驱动时的启动与映射表（ACP 会话视图设计 §5.2，补全架构
 * §5.1 第 3 条）。
 *
 * 纯数据加两个纯函数，不起进程：程序在补齐过的 PATH 上找（`resolveCommand`，
 * 与终端驱动同一条规则），起进程在 `client.ts`，协商在 `host.ts`。
 *
 * `modes` 的键与 `agent/launch.ts` 的 `permissionFlag` 是同一个集合——
 * `adapters.test.ts` 守着。`null` 表示这家在 ACP 下没有这个模式，界面不出现，
 * 与设置页「只提供有对应参数的权限模式」同一规矩。
 */

/** 这家怎么说 ACP：自带入口、官方适配器、随包的桥（ama 的 `--bridge`）。 */
export const ACP_SUPPORT = ["native", "official", "bundled"] as const;
export type AcpSupport = (typeof ACP_SUPPORT)[number];

/** 跨进程接回用哪个方法；`none` = 只能新开（Copilot）。 */
export const ACP_RESUME = ["load", "resume", "none"] as const;
export type AcpResume = (typeof ACP_RESUME)[number];

/**
 * ACP `sessionId` 与 CLI 自己的会话 id 怎么对上（设计 §4.3）：
 * `same` 相等；`opaque` 对不上，读镜像。
 */
export const ACP_SESSION_ID = ["same", "opaque"] as const;
export type AcpSessionIdRule = (typeof ACP_SESSION_ID)[number];

/** 落点的形状与各家的表在 `@armadra/shared` 的 `ACP_MODE_TABLE`（页面与 core 共用）。 */
export type { AcpModeMapping };

export interface AcpAdapter {
  /** 内置 id；`ama` 在 core 的注册表补上之前单列（G1-7）。 */
  readonly agentId: AgentId | "ama";
  readonly support: AcpSupport;
  /** 在补齐过的 PATH 上找的程序名。 */
  readonly program: string;
  /** 程序之后固定的 argv。 */
  readonly args: readonly string[];
  /**
   * 运行时才知道值的那个旗标：`ama --profile <path>`。给了 profile 路径才加，
   * 没给就不加（ama 自己用缺省 profile）。
   */
  readonly profileFlag?: string;
  readonly sessionId: AcpSessionIdRule;
  readonly resume: AcpResume;
  readonly modes: Readonly<Record<PermissionMode, AcpModeMapping | null>>;
  /**
   * 画布注入在 ACP 下还能用的那一半（设计 §5.8）。值（目录、令牌）由会话层
   * 从集成状态里取，这里只说用哪几条：
   *   * `mcp`：`session/new.mcpServers` 带 `armadra-hook mcp`；ama 走 profile
   *     的 host 适配器，不加，免得两套工具表；
   *   * `reuse`：终端启动器给的环境变量 / argv 照用；
   *   * `passthrough`：注入 argv 前面要隔一个 `--`（ama 的 pi 桥原样交给 pi）；
   *   * `mods`：Claude Code mod 经 `CLAUDE_CODE_PLUGIN_DIRS` 挂给适配器起的 CLI。
   */
  readonly injection: {
    readonly mcp: boolean;
    readonly reuse: readonly ("env" | "args")[];
    readonly passthrough?: "--";
    /**
     * `mcp` 的服务器不走 `session/new.mcpServers`、改成启动参数里的内联
     * 配置（Copilot：它在 ACP 下只收 http / sse，stdio 条目被丢弃，#858）。
     */
    readonly mcpViaArgs?: boolean;
    /**
     * 挂 Claude Code mod（契约 §59）：`CLAUDE_CODE_PLUGIN_DIRS` 指向 mod 目录、
     * `ARMADRA_MOD_PROFILE=acp`，门是适配器自带 CLI 的版本。mod 要靠节点身份
     * 找端点，所以这一家不预启动。
     */
    readonly mods?: boolean;
  };
  /** 前台进程门认的 argv[0] basename（会话 pid 就是适配器 pid）。 */
  readonly expectedProcess: readonly string[];
  /**
   * 以 ACP 驱动时它怎么在画布上建 Agent（契约 §48）：`mcp` = `canvas_open_agent`
   * / `canvas_team` 两个 MCP 工具（`injection.mcp` 必须为真）；`runners` = ama 的
   * 宿主 `HostApi.runners`；`none` = 适配器不接 MCP，
   * 只有终端视图能建。
   */
  readonly canvasTools: AcpCanvasTools;
}

export const ACP_CANVAS_TOOLS = ["mcp", "runners", "none"] as const;
export type AcpCanvasTools = (typeof ACP_CANVAS_TOOLS)[number];

export const ACP_ADAPTERS: readonly AcpAdapter[] = [
  {
    agentId: "claude",
    support: "official",
    program: "claude-agent-acp",
    args: [],
    sessionId: "same",
    resume: "load",
    modes: ACP_MODE_TABLE.claude,
    // `--settings` / `--plugin-dir` / `--append-system-prompt-file` 在 ACP
    // 下没有对应参数（D6）：画布工具走 MCP；mod 经 SDK 宿主认的
    // `CLAUDE_CODE_PLUGIN_DIRS` 挂（只挂 mod，不挂技能插件），只带斜杠命令与
    // hello，状态仍由 ACP 会话写。`CLAUDE_CONFIG_DIR` 不设，沿用用户登录。
    injection: { mcp: true, reuse: [], mods: true },
    expectedProcess: ["claude-agent-acp"],
    canvasTools: "mcp",
  },
  {
    agentId: "codex",
    support: "official",
    program: "codex-acp",
    args: [],
    sessionId: "same",
    resume: "load",
    modes: ACP_MODE_TABLE.codex,
    injection: { mcp: true, reuse: ["env"] },
    expectedProcess: ["codex-acp"],
    canvasTools: "mcp",
  },
  {
    agentId: "opencode",
    support: "native",
    program: "opencode",
    args: ["acp"],
    sessionId: "same",
    resume: "load",
    modes: ACP_MODE_TABLE.opencode,
    injection: { mcp: true, reuse: ["env"] },
    expectedProcess: ["opencode"],
    canvasTools: "mcp",
  },
  {
    agentId: "pi",
    support: "bundled",
    // 随包的 ama 说 Pi 的 ACP（AMA-Link/Armadra#716）：会话 id 就是 Pi 的；
    // 不带 ama 的 profile，Pi 自己登录。
    program: "ama",
    args: ["--mode", "acp", "--bridge", "pi"],
    sessionId: "same",
    resume: "load",
    modes: ACP_MODE_TABLE.pi,
    // `--` 之后的参数桥原样交给 pi（技能、系统提示注入照用）；MCP 由桥交给
    // Pi 内置的 MCP，画布工具走 §48 的 `mcp`。
    injection: { mcp: true, reuse: ["args"], passthrough: "--" },
    expectedProcess: ["ama", "ama.cjs"],
    canvasTools: "mcp",
  },
  {
    agentId: "omp",
    support: "native",
    program: "omp",
    args: ["acp"],
    sessionId: "same",
    resume: "load",
    modes: ACP_MODE_TABLE.omp,
    injection: { mcp: true, reuse: ["args"] },
    expectedProcess: ["omp"],
    canvasTools: "mcp",
  },
  {
    agentId: "copilot",
    support: "native",
    program: "copilot",
    args: ["--acp", "--stdio"],
    sessionId: "opaque",
    resume: "none",
    // 三条旗标在 `--acp` 下是否生效待真跑核实（G3-7）。
    modes: ACP_MODE_TABLE.copilot,
    injection: { mcp: true, mcpViaArgs: true, reuse: ["args", "env"] },
    expectedProcess: ["copilot"],
    canvasTools: "mcp",
  },
  {
    agentId: "ama",
    support: "native",
    program: "ama",
    args: ["--mode", "acp"],
    profileFlag: "--profile",
    sessionId: "same",
    resume: "resume",
    // 模式 id 就是 ama 的权限模式（`@armadra/agent` docs/acp.md）。
    modes: ACP_MODE_TABLE.ama,
    injection: { mcp: false, reuse: [] },
    expectedProcess: ["ama", "ama.cjs"],
    canvasTools: "runners",
  },
];

export function acpAdapter(agentId: string): AcpAdapter | undefined {
  return ACP_ADAPTERS.find((adapter) => adapter.agentId === agentId);
}

/** 这家在 ACP 下真有落点的权限模式；`default` 总在。 */
export function acpPermissionModes(
  adapter: AcpAdapter,
): readonly PermissionMode[] {
  return PERMISSION_MODES.filter(
    (mode) => mode === "default" || adapter.modes[mode] !== null,
  );
}

export interface AcpLaunchOptions {
  readonly mode?: PermissionMode;
  /** ama 的 profile 路径（G1-7 的注入产物）。 */
  readonly profilePath?: string;
  /** 终端注入复用的 argv（`reuse` 含 `args` 时才用）。 */
  readonly injectionArgs?: readonly string[];
  /** 节点的角色（`agent.role`）：只有注册表给它配了旗标的 CLI 才加。 */
  readonly role?: AgentRole;
}

export interface AcpLaunchPlan {
  /** 程序之后的完整 argv。 */
  readonly args: readonly string[];
  /** 起会话后要 `session/set_mode` 的 id；缺席 = 不调。 */
  readonly modeId?: string;
}

export type AcpLaunchError = {
  readonly code: "acp_mode_unsupported";
  readonly message: string;
};

/**
 * 一次启动的 argv 与模式 id。顺序：固定 argv → profile → 角色 → 模式 argv → 注入
 * （`passthrough` 的放最后，前面隔 `--`）。没有落点的模式答错误而不是悄悄
 * 用缺省：一个说了 `plan` 却以可写模式起来的会话比起不来更糟。
 */
export function acpLaunchPlan(
  adapter: AcpAdapter,
  options: AcpLaunchOptions = {},
): AcpLaunchPlan | AcpLaunchError {
  const mode = options.mode ?? "default";
  const mapping = adapter.modes[mode];
  if (mapping === null) {
    return {
      code: "acp_mode_unsupported",
      message: `${adapter.agentId} has no ACP mapping for permission mode ${mode}`,
    };
  }
  const args = [...adapter.args];
  if (adapter.profileFlag !== undefined && options.profilePath !== undefined) {
    args.push(adapter.profileFlag, options.profilePath);
  }
  args.push(...roleFlags(adapter.agentId, options.role));
  args.push(...(mapping.args ?? []));
  const injection = adapter.injection.reuse.includes("args")
    ? (options.injectionArgs ?? [])
    : [];
  if (injection.length > 0) {
    if (adapter.injection.passthrough !== undefined) {
      args.push(adapter.injection.passthrough);
    }
    args.push(...injection);
  }
  return mapping.modeId === undefined
    ? { args }
    : { args, modeId: mapping.modeId };
}

/**
 * 这个 Agent 以 ACP 起时用哪一行适配器。`custom:` 条目借它基础 CLI 的；基础
 * CLI 自己就是 ACP 入口（`native`）时，条目的启动程序与参数顶替表里的程序——
 * 一个包装了 `opencode` 的自定义条目，它的 ACP 入口就是那个包装。
 */
export function adapterFor(
  settings: AgentSettings,
  agentId: string,
): AcpAdapter | undefined {
  const adapter = acpAdapter(baseAgent(settings, agentId));
  if (adapter === undefined) return undefined;
  const custom = customAgent(settings, agentId);
  if (custom === undefined || adapter.support !== "native") return adapter;
  return {
    ...adapter,
    program: custom.launchCmd,
    args: [...(custom.args ?? []), ...adapter.args],
    expectedProcess: [
      ...adapter.expectedProcess,
      custom.launchCmd.split(/[/\\]/).pop() ?? custom.launchCmd,
    ],
  };
}
